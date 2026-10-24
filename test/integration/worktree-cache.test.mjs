import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { createZvecGrep } from "../../dist/index.js";
import { DaemonBackend } from "../../dist/daemon/backend.js";
import { FakeEmbeddingModel } from "../helpers/fake-embedding.mjs";
import { createTemporaryDirectory } from "../helpers/fixtures.mjs";

const exec = promisify(execFile);
class CountingModel extends FakeEmbeddingModel {
  documents = 0;
  constructor() {
    super();
    this.info = { ...this.info, cacheIdentity: "integration-deterministic-v1" };
  }
  async doEmbed(contents) {
    this.documents += contents.length;
    return super.doEmbed(contents);
  }
}

test(
  "real linked worktrees reuse vectors while paths, dirty changes, branch switches and index deletion remain isolated",
  { timeout: 120000 },
  async (t) => {
    const base = await createTemporaryDirectory(t, "zg-worktree-cache-");
    const root = join(base, "main");
    const feature = join(base, "feature");
    const global = join(base, "global");
    const previous = process.env.ZVEC_GREP_HOME;
    process.env.ZVEC_GREP_HOME = global;
    t.after(() =>
      previous === undefined
        ? delete process.env.ZVEC_GREP_HOME
        : (process.env.ZVEC_GREP_HOME = previous),
    );
    await mkdir(root);
    const git = async (cwd, ...args) =>
      exec("git", [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "core.autocrlf=false",
        "-c",
        `core.hooksPath=${join(base, "no-hooks")}`,
        "-C",
        cwd,
        ...args,
      ]);
    await git(root, "init", "--initial-branch=main");
    const shared =
      "export function SharedOriginal() { return 'shared original'; }\n";
    await writeFile(join(root, "shared.ts"), shared);
    await writeFile(join(root, "base.ts"), "export const BaseOnly = 42;\n");
    await writeFile(join(root, ".gitignore"), ".zvec-grep/\n");
    await git(root, "add", ".");
    await git(root, "commit", "-m", "initial");
    await git(root, "worktree", "add", "-b", "feature", feature);
    const mainModel = new CountingModel();
    const featureModel = new CountingModel();
    const main = await createZvecGrep({ root, embeddingModel: mainModel });
    const other = await createZvecGrep({
      root: feature,
      embeddingModel: featureModel,
    });
    const search = (service, query) =>
      service.context({
        routes: [{ mode: "fts", query }],
        autoUpdate: false,
        limit: 10,
      });
    try {
      const cold = await main.index({ globs: ["*.ts"] });
      const warm = await other.index({ globs: ["*.ts"] });
      assert.ok(cold.embeddingCache.computed > 0);
      assert.equal(warm.embeddingCache.computed, 0);
      assert.equal(
        featureModel.documents,
        0,
        "the second worktree must not infer identical fragments",
      );
      assert.equal(warm.embeddingCache.hits, cold.entitiesCreated);
      console.log(
        "worktree acceptance:",
        JSON.stringify({
          cold: cold.embeddingCache,
          warm: warm.embeddingCache,
        }),
      );

      await writeFile(
        join(feature, "shared.ts"),
        "export function FeatureUniqueChanged() { return 'uncommitted feature contents'; }\n",
      );
      await writeFile(
        join(feature, "extra.ts"),
        "export const FeatureExtraOnly = true;\n",
      );
      await rm(join(feature, "base.ts"));
      const dirty = await other.index();
      assert.ok(dirty.embeddingCache.computed > 0);
      assert.equal(dirty.filesDeleted, 1);
      assert.ok((await search(other, "FeatureUniqueChanged")).items.length > 0);
      assert.equal(
        (await search(main, "FeatureUniqueChanged")).items.length,
        0,
      );
      assert.equal((await search(other, "BaseOnly")).items.length, 0);
      for (const item of (await search(other, "FeatureUniqueChanged")).items) {
        const path = relative(
          await realpath(feature),
          await realpath(item.file.absolutePath),
        );
        assert.equal(isAbsolute(path) || path.startsWith(".."), false);
      }

      const parallelSource =
        "export const SharedParallelMiss = 'one inference across worktrees';\n";
      await writeFile(join(root, "parallel.ts"), parallelSource);
      await writeFile(join(feature, "parallel.ts"), parallelSource);
      const concurrent = await Promise.all([main.index(), other.index()]);
      assert.equal(
        concurrent.reduce(
          (sum, result) => sum + result.embeddingCache.computed,
          0,
        ),
        1,
      );

      await git(root, "checkout", "-b", "alternate");
      await writeFile(
        join(root, "shared.ts"),
        "export const AlternateBranchUnique = 'alternate branch';\n",
      );
      await git(root, "add", "shared.ts");
      await git(root, "commit", "-m", "alternate");
      const switched = await main.index();
      assert.ok(switched.embeddingCache.computed > 0);
      await git(root, "checkout", "main");
      const restored = await main.index();
      assert.equal(restored.embeddingCache.computed, 0);
      assert.ok(restored.embeddingCache.hits > 0);
      assert.equal(
        (await search(main, "AlternateBranchUnique")).items.length,
        0,
      );
      assert.ok((await search(main, "SharedOriginal")).items.length > 0);

      await rename(join(feature, "shared.ts"), join(feature, "renamed.ts"));
      const renamed = await other.index();
      assert.equal(renamed.filesDeleted, 1);
      const renamedHits = (await search(other, "FeatureUniqueChanged")).items;
      assert.ok(
        renamedHits.every((item) => item.file.relativePath === "renamed.ts"),
      );
      await other.dropIndex();
      const rebuilt = await other.index();
      assert.equal(
        rebuilt.embeddingCache.computed,
        0,
        "dropping a worktree index must retain the shared cache",
      );
      assert.ok((await search(main, "SharedOriginal")).items.length > 0);

      const unrelated = join(base, "unrelated");
      await mkdir(unrelated);
      await git(unrelated, "init", "--initial-branch=main");
      await writeFile(join(unrelated, "shared.ts"), shared);
      const separate = await createZvecGrep({
        root: unrelated,
        embeddingModel: new CountingModel(),
      });
      try {
        const isolated = await separate.index({ globs: ["*.ts"] });
        assert.ok(
          isolated.embeddingCache.computed > 0,
          "another repository must not consume this repository's cache",
        );
        assert.equal(isolated.embeddingCache.hits, 0);
      } finally {
        await separate.close();
      }

      await rm(join(global, "embedding-cache-v1"), {
        recursive: true,
        force: true,
      });
      const noCache = await main.index({ rebuild: true });
      assert.ok(
        noCache.embeddingCache.computed > 0,
        "cache removal must only cost recomputation",
      );
      assert.ok((await search(main, "SharedOriginal")).items.length > 0);
    } finally {
      await main.close();
      await other.close();
    }
    const backend = new DaemonBackend({
      version: "test",
      modelPoolOptions: { createModel: () => new CountingModel() },
      watchManagerFactory: () => ({
        start() {},
        flushPending: async () => {},
        close: async () => {},
      }),
    });
    try {
      const result = await backend.index({
        root,
        wait: true,
        rebuild: true,
        embedding: "test/deterministic",
      });
      assert.equal(result.state, "succeeded", JSON.stringify(result.error));
      assert.ok(result.embeddingCache.hits > 0);
      assert.equal(result.embeddingCache.computed, 0);
    } finally {
      await backend.close();
    }
  },
);
