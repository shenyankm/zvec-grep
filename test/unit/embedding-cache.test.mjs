import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { repositoryEmbeddingCache } from "../../dist/engine/pipeline/indexing/embedding-cache.js";
import { FakeEmbeddingModel } from "../helpers/fake-embedding.mjs";
import { createTemporaryDirectory } from "../helpers/fixtures.mjs";

const exec = promisify(execFile);
const text = (value) => ({ kind: "text", text: value });
class Model extends FakeEmbeddingModel {
  calls = 0;
  prepared = 0;
  constructor(identity = "deterministic-v1") {
    super();
    this.info = { ...this.info, cacheIdentity: identity };
  }
  async prepare() {
    this.prepared++;
  }
  async doEmbed(contents, options) {
    this.calls += contents.length;
    await this.gate?.(options);
    const result = await super.doEmbed(contents);
    result.truncated = contents.flatMap((content, i) =>
      content.text.includes("truncated") ? [i] : [],
    );
    return result;
  }
}
async function fixture(t) {
  const base = await createTemporaryDirectory(t, "zg-vector-cache-");
  const root = join(base, "repo");
  const home = join(base, "global");
  await mkdir(root);
  await exec("git", ["-C", root, "init", "--initial-branch=main"]);
  const previous = process.env.ZVEC_GREP_HOME;
  process.env.ZVEC_GREP_HOME = home;
  t.after(() =>
    previous === undefined
      ? delete process.env.ZVEC_GREP_HOME
      : (process.env.ZVEC_GREP_HOME = previous),
  );
  const workspace = { rootPaths: [{ absolutePath: root, recursive: true }] };
  return {
    root,
    home,
    workspace,
    cache: async (model = new Model()) =>
      repositoryEmbeddingCache(model, workspace),
  };
}
async function records(home) {
  const directory = join(home, "embedding-cache-v1");
  return (await readdir(directory, { recursive: true }))
    .filter((path) => path.endsWith(".json"))
    .map((path) => join(directory, path));
}

test("persistent cache deduplicates exact inputs, restores order and truncation, and avoids model preparation on hits", async (t) => {
  const { cache } = await fixture(t);
  const model = new Model();
  const first = await cache(model);
  const inputs = [
    text("truncated alpha"),
    text("beta"),
    text("truncated alpha"),
  ];
  const result = await first.model.embed(inputs);
  assert.equal(model.calls, 2);
  assert.deepEqual(result.truncated, [0, 2]);
  assert.deepEqual(first.stats, { hits: 1, computed: 2, errors: 0 });
  const restarted = new Model();
  const second = await cache(restarted);
  assert.deepEqual(await second.model.embed(inputs), result);
  assert.equal(restarted.calls, 0);
  assert.equal(restarted.prepared, 0);
  assert.deepEqual(second.stats, { hits: 3, computed: 0, errors: 0 });
  result.vectors[0][0] = 999;
  assert.notEqual((await second.model.embed(inputs)).vectors[0][0], 999);
  await second.model.embed([text("query")], { purpose: "query" });
  assert.equal(restarted.calls, 1, "queries bypass the document cache");
});

test("full contextual input, model revision, endpoint and dimension cannot cross-hit", async (t) => {
  const { cache } = await fixture(t);
  const initial = await cache();
  await initial.model.embed([text("scope: one\nidentical body")]);
  const contextual = await cache();
  await contextual.model.embed([text("scope: two\nidentical body")]);
  assert.equal(contextual.stats.computed, 1);
  for (const [name, value] of [
    ["cacheIdentity", "new-weights"],
    ["endpoint", "http://different.invalid"],
    ["dimension", 8],
  ]) {
    const model = new Model();
    model.info = { ...model.info, [name]: value };
    const changed = await cache(model);
    await changed.model.embed([text("scope: one\nidentical body")]);
    assert.equal(changed.stats.computed, 1, name);
  }
});

test("corruption and missing records recompute safely; writes are atomic", async (t) => {
  const { home, cache } = await fixture(t);
  await (await cache()).model.embed([text("alpha")]);
  const [path] = await records(home);
  for (const corrupt of [
    "not json",
    JSON.stringify({ key: "wrong", vector: [] }),
    (await readFile(path, "utf8")).replace(
      '"truncated":false',
      '"truncated":true',
    ),
  ]) {
    await writeFile(path, corrupt);
    const retry = await cache();
    await retry.model.embed([text("alpha")]);
    assert.equal(retry.stats.computed, 1);
    assert.equal(
      retry.stats.errors,
      2,
      "optimistic and locked reads both validate the corrupt record",
    );
    JSON.parse(await readFile(path, "utf8"));
  }
  await rm(path);
  const missing = await cache();
  await missing.model.embed([text("alpha")]);
  assert.equal(missing.stats.computed, 1);
  const all = await readdir(join(home, "embedding-cache-v1"), {
    recursive: true,
  });
  assert.equal(
    all.some((name) => name.endsWith(".tmp")),
    false,
  );
});

test("concurrent batches share in-flight work; cancelling a follower does not cancel the owner", async (t) => {
  const { cache } = await fixture(t);
  let started;
  let release;
  const entered = new Promise((resolve) => {
    started = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const owner = new Model();
  owner.gate = () => {
    started();
    return gate;
  };
  const first = await cache(owner);
  const follower = await cache();
  const running = first.model.embed([text("same")]);
  await entered;
  const controller = new AbortController();
  const waiting = follower.model.embed([text("same")], {
    signal: controller.signal,
  });
  // Allow the follower to finish its cache-file lookup and join the owner.
  while (follower.stats.hits === 0)
    await new Promise((resolve) => setTimeout(resolve, 5));
  controller.abort();
  await assert.rejects(waiting, { name: "AbortError" });
  release();
  await running;
  assert.equal(owner.calls, 1);
  assert.equal(follower.stats.computed, 0);
  assert.equal(
    (await (await cache()).model.embed([text("same")])).vectors.length,
    1,
  );
});

test("multiple processes publish complete records without partial files", async (t) => {
  const { home, root, cache } = await fixture(t);
  const cacheModule = new URL(
    "../../dist/engine/pipeline/indexing/embedding-cache.js",
    import.meta.url,
  ).href;
  const modelModule = new URL("../helpers/fake-embedding.mjs", import.meta.url)
    .href;
  const script = `
    import { repositoryEmbeddingCache } from ${JSON.stringify(cacheModule)};
    import { FakeEmbeddingModel } from ${JSON.stringify(modelModule)};
    const model = new FakeEmbeddingModel();
    model.info = { ...model.info, cacheIdentity: "deterministic-v1" };
    const original = model.embed.bind(model);
    model.embed = async (...args) => {
      await new Promise(resolve => setTimeout(resolve, 100));
      return original(...args);
    };
    const cache = await repositoryEmbeddingCache(model, {rootPaths:[{absolutePath:${JSON.stringify(root)}}]});
    await cache.model.embed([{kind:"text",text:"cross-process"}]);
    console.log(JSON.stringify(cache.stats));
  `;
  const processes = await Promise.all([
    exec(process.execPath, ["--input-type=module", "-e", script]),
    exec(process.execPath, ["--input-type=module", "-e", script]),
  ]);
  assert.equal(
    processes.reduce(
      (sum, result) => sum + JSON.parse(result.stdout).computed,
      0,
    ),
    1,
    "a cross-process miss is inferred only once",
  );
  const verified = await cache();
  await verified.model.embed([text("cross-process")]);
  assert.equal(verified.stats.hits, 1);
  assert.equal(verified.stats.errors, 0);
  assert.equal((await records(home)).length, 1);
});

test(
  "cancellation during miss reservation releases in-flight entries",
  { timeout: 3000 },
  async (t) => {
    const { cache } = await fixture(t);
    const owner = await cache();
    const controller = new AbortController();
    const check = controller.signal.throwIfAborted.bind(controller.signal);
    let checks = 0;
    t.mock.method(controller.signal, "throwIfAborted", () => {
      if (++checks === 3) controller.abort();
      check();
    });
    await assert.rejects(
      owner.model.embed([text("first"), text("second")], {
        signal: controller.signal,
      }),
      { name: "AbortError" },
    );
    const retry = await cache();
    await retry.model.embed([text("first")]);
    assert.equal(retry.stats.computed, 1);
  },
);

test("invalid model output and cache write failures cannot publish misleading vectors", async (t) => {
  const { home, cache } = await fixture(t);
  for (const invalid of [
    { vectors: [[1]], truncated: [] },
    { vectors: [new Array(16)], truncated: [] },
    { vectors: new Array(1), truncated: [] },
    { vectors: [new Array(16).fill(NaN)], truncated: [] },
    { vectors: [new Array(16).fill(0)], truncated: [0, 0] },
    { vectors: [new Array(16).fill(0)], truncated: new Array(1) },
  ]) {
    const model = new Model();
    model.embed = async () => invalid;
    await assert.rejects(
      (await cache(model)).model.embed([text("invalid")]),
      /invalid model result/,
    );
  }
  assert.equal((await records(home)).length, 0);
  const writable = await cache();
  await rm(join(home, "embedding-cache-v1"), { recursive: true, force: true });
  const result = await writable.model.embed([text("fallback")]);
  assert.equal(result.vectors.length, 1);
  assert.equal(writable.stats.computed, 1);
  assert.ok(writable.stats.errors > 0);
});

test("automatic finish enforces the cache budget without changing returned vectors", async (t) => {
  const { cache } = await fixture(t);
  const previous = process.env.ZVEC_GREP_VECTOR_CACHE_MAX_BYTES;
  process.env.ZVEC_GREP_VECTOR_CACHE_MAX_BYTES = "1000";
  t.after(() =>
    previous === undefined
      ? delete process.env.ZVEC_GREP_VECTOR_CACHE_MAX_BYTES
      : (process.env.ZVEC_GREP_VECTOR_CACHE_MAX_BYTES = previous),
  );
  const cached = await cache();
  const inputs = Array.from({ length: 32 }, (_, index) =>
    text(`budget input ${index}`),
  );
  const result = await cached.model.embed(inputs);
  await cached.finish();
  const { maintainVectorCache } =
    await import("../../dist/engine/pipeline/indexing/cache-maintenance.js");
  assert.ok((await maintainVectorCache("status")).bytes <= 1000);
  assert.equal(result.vectors.length, inputs.length);
  assert.equal(cached.stats.computed, inputs.length);
  process.env.ZVEC_GREP_VECTOR_CACHE_MAX_BYTES = "0";
  assert.equal(await cache(), undefined);
});

test("failed computation is never published and can be retried", async (t) => {
  const { cache } = await fixture(t);
  const failing = new Model();
  failing.gate = async () => {
    throw new Error("inference failed");
  };
  await assert.rejects(
    (await cache(failing)).model.embed([text("retry")]),
    /inference failed/,
  );
  const retry = await cache();
  await retry.model.embed([text("retry")]);
  assert.equal(retry.stats.computed, 1);
});

test("unavailable cache, unpinned models, non-Git and multi-root workspaces bypass reuse; cancellation is respected", async (t) => {
  const { home, workspace, cache } = await fixture(t);
  await mkdir(home, { recursive: true });
  await writeFile(join(home, "embedding-cache-v1"), "not a directory");
  assert.equal(await cache(), undefined);
  assert.equal(
    await repositoryEmbeddingCache(new FakeEmbeddingModel(), workspace),
    undefined,
  );
  assert.equal(
    await repositoryEmbeddingCache(new Model(), { rootPaths: [] }),
    undefined,
  );
  assert.equal(
    await repositoryEmbeddingCache(new Model(), {
      rootPaths: [{ absolutePath: home }],
    }),
    undefined,
  );
  await assert.rejects(
    repositoryEmbeddingCache(new Model(), workspace, AbortSignal.abort()),
    { name: "AbortError" },
  );
});
