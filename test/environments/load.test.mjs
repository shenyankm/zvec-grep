import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, realpath, statfs, writeFile } from "node:fs/promises";
import { join, relative, isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { createZvecGrep } from "../../dist/index.js";
import { repositoryEmbeddingCache } from "../../dist/engine/pipeline/indexing/embedding-cache.js";
import { maintainVectorCache } from "../../dist/engine/pipeline/indexing/cache-maintenance.js";
import { DaemonBackend } from "../../dist/daemon/backend.js";
import { DaemonHttpServer } from "../../dist/daemon/http-server.js";
import { FakeEmbeddingModel } from "../helpers/fake-embedding.mjs";
import { createTemporaryDirectory } from "../helpers/fixtures.mjs";

const exec = promisify(execFile);
class Model extends FakeEmbeddingModel {
  constructor() {
    super();
    this.info = {
      ...this.info,
      dimension: 1024,
      cacheIdentity: "dense-load-v1",
    };
  }
  async doEmbed(contents) {
    return {
      vectors: contents.map((content) => {
        const seed = content.text.length;
        const vector = Array.from({ length: 1024 }, (_, index) =>
          Math.sin(seed + index + 1),
        );
        const norm = Math.sqrt(
          vector.reduce((sum, value) => sum + value * value, 0),
        );
        return vector.map((value) => value / norm);
      }),
      truncated: [],
    };
  }
}

test(
  "20 real worktrees, dense vector reuse, native indexes, and real daemon request bursts",
  { timeout: 600000 },
  async (t) => {
    const base = await createTemporaryDirectory(t, "zg-environment-load-");
    const free = await statfs(base);
    if (free.bavail * free.bsize < 1024 ** 3) {
      t.skip("requires 1 GiB of temporary free space");
      return;
    }
    const original = Object.fromEntries(
      [
        "ZVEC_GREP_HOME",
        "ZVEC_GREP_VECTOR_CACHE_MAX_BYTES",
        "ZVEC_GREP_VECTOR_CACHE_MAX_AGE_DAYS",
      ].map((key) => [key, process.env[key]]),
    );
    process.env.ZVEC_GREP_HOME = join(base, "global");
    process.env.ZVEC_GREP_VECTOR_CACHE_MAX_BYTES = String(512 * 1024 * 1024);
    process.env.ZVEC_GREP_VECTOR_CACHE_MAX_AGE_DAYS = "30";
    t.after(() => {
      for (const [key, value] of Object.entries(original)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
    const chunks = Number(process.env.ZG_TEST_CHUNKS ?? 10000);
    const trees = Number(process.env.ZG_TEST_WORKTREES ?? 20);
    assert.ok(Number.isInteger(chunks) && chunks > 0 && chunks <= 50000);
    assert.ok(Number.isInteger(trees) && trees > 0 && trees <= 32);
    const root = join(base, "main");
    await mkdir(root);
    const git = (cwd, ...args) =>
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
    await writeFile(join(root, ".gitignore"), ".zvec-grep/\n");
    for (let index = 0; index < 256; index++)
      await writeFile(
        join(root, `source-${index}.ts`),
        `export const LoadSymbol${index} = ${index};\n`,
      );
    await git(root, "add", ".");
    await git(root, "commit", "-m", "load fixture");
    const roots = [root];
    for (let index = 1; index < trees; index++) {
      const path = join(base, `worktree-${index}`);
      await git(root, "worktree", "add", "--detach", path);
      roots.push(path);
    }
    const start = performance.now();
    let peakRss = process.memoryUsage().rss;
    const native = [];
    for (const path of roots.slice(0, 4)) {
      const service = await createZvecGrep({
        root: path,
        embeddingModel: new Model(),
      });
      try {
        const result = await service.index({ globs: ["*.ts"] });
        native.push(result.embeddingCache);
        assert.equal(result.filesFailed, 0);
        if (native.length > 1) assert.equal(result.embeddingCache.computed, 0);
        const hits = await service.context({
          routes: [{ mode: "fts", query: "LoadSymbol255" }],
          autoUpdate: false,
          limit: 5,
        });
        assert.ok(hits.items.length > 0);
        for (const item of hits.items) {
          const file = relative(
            await realpath(path),
            await realpath(item.file.absolutePath),
          );
          assert.equal(isAbsolute(file) || file.startsWith(".."), false);
        }
      } finally {
        await service.close();
      }
      peakRss = Math.max(peakRss, process.memoryUsage().rss);
    }
    const inputs = Array.from({ length: chunks }, (_, index) => ({
      kind: "text",
      text: `dense input ${index}: ${"context ".repeat(16)}`,
    }));
    const seed = await repositoryEmbeddingCache(new Model(), {
      rootPaths: [{ absolutePath: root }],
    });
    for (let index = 0; index < inputs.length; index += 128)
      await seed.model.embed(inputs.slice(index, index + 128));
    await seed.finish();
    assert.equal(seed.stats.computed, chunks);
    global.gc?.();
    const heapBefore = process.memoryUsage().heapUsed;
    let reused = 0;
    for (const path of roots) {
      const cache = await repositoryEmbeddingCache(new Model(), {
        rootPaths: [{ absolutePath: path }],
      });
      for (let index = 0; index < inputs.length; index += 128) {
        const result = await cache.model.embed(
          inputs.slice(index, index + 128),
        );
        assert.equal(result.vectors[0].length, 1024);
        peakRss = Math.max(peakRss, process.memoryUsage().rss);
      }
      await cache.finish();
      assert.equal(cache.stats.computed, 0);
      reused += cache.stats.hits;
    }
    global.gc?.();
    const heapAfter = process.memoryUsage().heapUsed;
    if (global.gc) assert.ok(heapAfter - heapBefore < 128 * 1024 * 1024);
    const backend = new DaemonBackend({
      version: "load-test",
      modelPoolOptions: { createModel: () => new Model() },
      watchManagerFactory: () => ({
        start() {},
        flushPending: async () => {},
        close: async () => {},
      }),
    });
    const server = new DaemonHttpServer({
      host: "127.0.0.1",
      port: 0,
      token: "load-test",
      version: "load-test",
      mcpToolset: "full",
      backend,
    });
    const address = await server.start();
    const plugin = fileURLToPath(
      new URL("../../../pi-zvec-status/", import.meta.url),
    );
    const { Client } = await import(
      pathToFileURL(
        join(
          plugin,
          "node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js",
        ),
      ).href
    );
    const { StreamableHTTPClientTransport } = await import(
      pathToFileURL(
        join(
          plugin,
          "node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js",
        ),
      ).href
    );
    let checked = 0;
    let cursor = 0;
    try {
      await Promise.all(
        Array.from({ length: 4 }, async () => {
          while (cursor < roots.length * 2) {
            const index = cursor++;
            const path = roots[index % roots.length];
            const client = new Client({ name: "load-test", version: "1" });
            const transport = new StreamableHTTPClientTransport(
              new URL(`http://127.0.0.1:${address.port}/mcp`),
              {
                requestInit: { headers: { Authorization: "Bearer load-test" } },
              },
            );
            try {
              await client.connect(transport);
              const response = await client.callTool({
                name: "zvec_grep_index_status",
                arguments: { root: path },
              });
              assert.notEqual(response.isError, true);
              assert.equal(
                await realpath(response.structuredContent.root),
                await realpath(path),
              );
              checked++;
            } finally {
              await transport.terminateSession().catch(() => {});
              await client.close();
            }
          }
        }),
      );
    } finally {
      await server.close();
      await backend.close();
    }
    const cache = await maintainVectorCache("status");
    const cleared = await maintainVectorCache("clear");
    assert.ok(cleared.removed >= chunks);
    const stillIndexed = await createZvecGrep({
      root,
      embeddingModel: new Model(),
    });
    try {
      const result = await stillIndexed.context({
        routes: [{ mode: "fts", query: "LoadSymbol255" }],
        autoUpdate: false,
        limit: 5,
      });
      assert.ok(
        result.items.length > 0,
        "cache eviction must not invalidate the native index",
      );
    } finally {
      await stillIndexed.close();
    }
    console.log(
      "ENVIRONMENT_LOAD",
      JSON.stringify({
        trees,
        nativeIndexes: native.length,
        filesPerNativeIndex: 256,
        native,
        dimensions: 1024,
        chunks,
        reused,
        daemonChecks: checked,
        cacheBytes: cache.bytes,
        peakRssMiB: +(peakRss / 1048576).toFixed(1),
        heapGrowthMiB: +((heapAfter - heapBefore) / 1048576).toFixed(1),
        gcExposed: !!global.gc,
        indexSurvivedCacheClear: true,
        seconds: +((performance.now() - start) / 1000).toFixed(2),
      }),
    );
  },
);
