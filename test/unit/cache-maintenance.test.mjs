import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  readFile,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  cachePolicy,
  maintainVectorCache,
} from "../../dist/engine/pipeline/indexing/cache-maintenance.js";
import { createTemporaryDirectory, runCli } from "../helpers/fixtures.mjs";

async function fixture(t) {
  const home = await createTemporaryDirectory(t, "zg-cache-maintenance-");
  const original = Object.fromEntries(
    [
      "ZVEC_GREP_HOME",
      "ZVEC_GREP_VECTOR_CACHE_MAX_BYTES",
      "ZVEC_GREP_VECTOR_CACHE_MAX_AGE_DAYS",
    ].map((key) => [key, process.env[key]]),
  );
  process.env.ZVEC_GREP_HOME = home;
  process.env.ZVEC_GREP_VECTOR_CACHE_MAX_BYTES = "1000";
  process.env.ZVEC_GREP_VECTOR_CACHE_MAX_AGE_DAYS = "30";
  t.after(() => {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const root = join(home, "embedding-cache-v1");
  const directory = join(root, "a".repeat(64), "b".repeat(64));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const record = async (index, size, age = 0) => {
    const path = join(
      directory,
      `${index.toString(16).padStart(64, "0")}.json`,
    );
    await writeFile(path, "x".repeat(size), { mode: 0o600 });
    const at = new Date(Date.now() - age);
    await utimes(path, at, at);
    return path;
  };
  return { home, root, directory, record };
}

test("budget and retention prune only recognized disposable records, oldest writes first", async (t) => {
  const { home, directory, record } = await fixture(t);
  const old = await record(1, 600, 10000);
  const newer = await record(2, 600, 5000);
  const sentinel = join(home, ".zvec-grep", "index.zvec");
  await mkdir(join(home, ".zvec-grep"));
  await writeFile(sentinel, "independent index");
  await writeFile(join(directory, "unrecognized.txt"), "do not delete");
  assert.equal((await maintainVectorCache("status")).bytes, 1200);
  const pruned = await maintainVectorCache();
  assert.equal(pruned.removed, 1);
  assert.equal(pruned.bytes, 600);
  await assert.rejects(readFile(old), { code: "ENOENT" });
  assert.equal((await readFile(newer)).length, 600);
  const expired = new Date(Date.now() - 31 * 86400000);
  await utimes(newer, expired, expired);
  assert.equal((await maintainVectorCache()).removed, 1);
  await record(3, 100);
  assert.equal((await maintainVectorCache("clear")).bytes, 0);
  assert.equal(await readFile(sentinel, "utf8"), "independent index");
  assert.equal(
    await readFile(join(directory, "unrecognized.txt"), "utf8"),
    "do not delete",
  );
});

test("cleanup never follows a linked repository cache directory", async (t) => {
  const { home, root } = await fixture(t);
  const outside = join(home, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "secret"), "preserve");
  await symlink(
    outside,
    join(root, "c".repeat(64)),
    process.platform === "win32" ? "junction" : "dir",
  );
  await maintainVectorCache("clear");
  assert.equal(await readFile(join(outside, "secret"), "utf8"), "preserve");
});

test("a missing cache reports empty state and defaults to a 512 MiB, 30-day budget", async (t) => {
  const { root } = await fixture(t);
  await rm(root, { recursive: true });
  delete process.env.ZVEC_GREP_VECTOR_CACHE_MAX_BYTES;
  delete process.env.ZVEC_GREP_VECTOR_CACHE_MAX_AGE_DAYS;
  assert.deepEqual(cachePolicy(), {
    maxBytes: 512 * 1024 * 1024,
    maxAgeMs: 30 * 86400000,
  });
  const status = await maintainVectorCache("clear");
  assert.equal(status.exists, false);
  assert.equal(status.bytes, 0);
  assert.equal(status.removed, 0);
});

test("cleanup preserves live-writer temporaries and rejects unsafe cache directories", async (t) => {
  const { root, directory } = await fixture(t);
  const temporary = (pid) =>
    join(
      directory,
      `${"d".repeat(64)}.json.${pid}.00000000-0000-0000-0000-000000000000.tmp`,
    );
  const live = temporary(process.pid);
  const dead = temporary(2147483647);
  await writeFile(live, "live", { mode: 0o600 });
  await writeFile(dead, "dead", { mode: 0o600 });
  assert.equal((await maintainVectorCache()).removed, 1);
  assert.equal(await readFile(live, "utf8"), "live");
  await assert.rejects(readFile(dead), { code: "ENOENT" });
  if (process.platform !== "win32") {
    await chmod(root, 0o755);
    await assert.rejects(
      maintainVectorCache("clear"),
      /private, owned directory/,
    );
    await chmod(root, 0o700);
    const uid = process.getuid();
    t.mock.method(process, "getuid", () => uid + 1);
    await assert.rejects(
      maintainVectorCache("clear"),
      /private, owned directory/,
    );
    t.mock.restoreAll();
  }
  assert.equal(await readFile(live, "utf8"), "live");
});

test("cache CLI reports JSON, enforces its action, and never starts indexing", async (t) => {
  const { home, record } = await fixture(t);
  await record(1, 1200);
  const env = {
    ZVEC_GREP_HOME: home,
    ZVEC_GREP_VECTOR_CACHE_MAX_BYTES: "1000",
  };
  const before = JSON.parse(
    (await runCli(["--cache", "status"], { env })).stdout,
  );
  assert.equal(before.bytes, 1200);
  const pruned = JSON.parse(
    (await runCli(["--cache", "prune"], { env })).stdout,
  );
  assert.equal(pruned.bytes, 0);
  const cleared = JSON.parse(
    (await runCli(["--cache", "clear"], { env })).stdout,
  );
  assert.equal(cleared.removed, 0);
  await assert.rejects(
    runCli(["--cache", "not-an-action"], { env }),
    /requires status, prune, or clear/,
  );
  await assert.rejects(maintainVectorCache("clear", AbortSignal.abort()), {
    name: "AbortError",
  });
  process.env.ZVEC_GREP_VECTOR_CACHE_MAX_BYTES = "invalid";
  assert.throws(cachePolicy, /Invalid vector cache/);
});
