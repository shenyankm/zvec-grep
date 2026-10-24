import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { repositoryEmbeddingCache } from "../../dist/engine/pipeline/indexing/embedding-cache.js";
import { maintainVectorCache } from "../../dist/engine/pipeline/indexing/cache-maintenance.js";
import { FakeEmbeddingModel } from "../helpers/fake-embedding.mjs";
import { createTemporaryDirectory } from "../helpers/fixtures.mjs";

const exec = promisify(execFile);
const content = { kind: "text", text: "fault fixture" };
async function fixture(t) {
  const home = await createTemporaryDirectory(t, "zg-real-fault-");
  const root = join(home, "repo");
  await mkdir(root);
  await exec("git", ["-C", root, "init", "-q"]);
  const original = process.env.ZVEC_GREP_HOME;
  process.env.ZVEC_GREP_HOME = join(home, "global");
  t.after(() =>
    original === undefined
      ? delete process.env.ZVEC_GREP_HOME
      : (process.env.ZVEC_GREP_HOME = original),
  );
  const workspace = { rootPaths: [{ absolutePath: root, recursive: true }] };
  const model = () => {
    const result = new FakeEmbeddingModel();
    result.info = { ...result.info, cacheIdentity: "real-fault-v1" };
    return result;
  };
  const cache = () => repositoryEmbeddingCache(model(), workspace);
  const records = async () => {
    const base = join(home, "global/embedding-cache-v1");
    return (await readdir(base, { recursive: true }))
      .filter((name) => /^[0-9a-f]{64}\.json$/.test(name.split(/[\\/]/).at(-1)))
      .map((name) => join(base, name));
  };
  return { root, cache, records, workspace };
}

async function childAtBarrier(t, script) {
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exit = once(child, "exit");
      child.kill("SIGKILL");
      await exit;
    }
  });
  await new Promise((resolve, reject) => {
    let output = "";
    child.stdout.on("data", (data) => {
      output += data;
      if (output.includes("BARRIER")) resolve();
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (!output.includes("BARRIER"))
        reject(new Error(`Child exited before barrier: ${code}`));
    });
  });
  return child;
}

test(
  "SIGKILL before atomic rename preserves the published record and stale temp cleanup recovers",
  { timeout: 10000, skip: process.platform === "win32" },
  async (t) => {
    const { cache, records } = await fixture(t);
    await (await cache()).model.embed([content]);
    const [target] = await records();
    const before = await readFile(target, "utf8");
    const atomic = new URL(
      "../../dist/engine/utils/atomic-file.js",
      import.meta.url,
    ).href;
    const child = await childAtBarrier(
      t,
      `
    import fs from 'node:fs/promises';
    import { syncBuiltinESMExports } from 'node:module';
    fs.rename = async () => { console.log('BARRIER'); await new Promise(() => {}); };
    syncBuiltinESMExports();
    const { replaceFileAtomically } = await import(${JSON.stringify(atomic)});
    setInterval(() => {}, 1000);
    await replaceFileAtomically(${JSON.stringify(target)}, 'unpublished interrupted payload', {mode:0o600});
  `,
    );
    const exit = once(child, "exit");
    child.kill("SIGKILL");
    await exit;
    assert.equal(await readFile(target, "utf8"), before);
    assert.equal((await maintainVectorCache()).removed, 1);
    const verified = await cache();
    await verified.model.embed([content]);
    assert.equal(verified.stats.hits, 1);
    assert.equal(verified.stats.computed, 0);
  },
);

test(
  "SIGKILL of a computing owner releases its stale cross-process lease for a follower",
  { timeout: 10000, skip: process.platform === "win32" },
  async (t) => {
    const { cache, workspace } = await fixture(t);
    const cacheModule = new URL(
      "../../dist/engine/pipeline/indexing/embedding-cache.js",
      import.meta.url,
    ).href;
    const modelModule = new URL(
      "../helpers/fake-embedding.mjs",
      import.meta.url,
    ).href;
    const child = await childAtBarrier(
      t,
      `
    import { repositoryEmbeddingCache } from ${JSON.stringify(cacheModule)};
    import { FakeEmbeddingModel } from ${JSON.stringify(modelModule)};
    const model=new FakeEmbeddingModel(); model.info={...model.info,cacheIdentity:'real-fault-v1'};
    model.doEmbed=async () => { console.log('BARRIER'); await new Promise(resolve=>setTimeout(resolve,60000)); };
    const cache=await repositoryEmbeddingCache(model,${JSON.stringify(workspace)});
    await cache.model.embed([${JSON.stringify(content)}]);
  `,
    );
    const follower = await cache();
    const completed = follower.model.embed([content]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const exit = once(child, "exit");
    child.kill("SIGKILL");
    await exit;
    const result = await completed;
    assert.equal(result.vectors.length, 1);
    assert.equal(follower.stats.computed, 1);
    const verified = await cache();
    await verified.model.embed([content]);
    assert.equal(verified.stats.hits, 1);
  },
);

test(
  "real read-only cache permissions fall back to inference without losing vectors",
  { skip: process.platform === "win32" || process.getuid?.() === 0 },
  async (t) => {
    const { cache, records } = await fixture(t);
    await (await cache()).model.embed([content]);
    const [target] = await records();
    const directory = dirname(target);
    const cached = await cache();
    await chmod(directory, 0o500);
    try {
      const result = await cached.model.embed([
        { kind: "text", text: "new uncacheable input" },
      ]);
      assert.equal(result.vectors.length, 1);
      assert.equal(cached.stats.computed, 1);
      assert.ok(cached.stats.errors > 0);
    } finally {
      await chmod(directory, 0o700);
    }
  },
);
