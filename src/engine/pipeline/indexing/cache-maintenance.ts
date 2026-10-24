import { lstat, opendir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { defaultHome } from "../../utils/path.js";

export function cachePolicy() {
  const maxBytes = Number(
    process.env.ZVEC_GREP_VECTOR_CACHE_MAX_BYTES ?? 512 * 1024 * 1024,
  );
  const days = Number(process.env.ZVEC_GREP_VECTOR_CACHE_MAX_AGE_DAYS ?? 30);
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 0 ||
    !Number.isFinite(days) ||
    days < 0 ||
    days > 36500
  ) {
    throw new Error("Invalid vector cache budget or retention period.");
  }
  return { maxBytes, maxAgeMs: days * 86400000 };
}

export function vectorCacheRoot() {
  return join(defaultHome(), "embedding-cache-v1");
}

export async function assertPrivateCacheDirectory(path: string) {
  const info = await lstat(path);
  if (
    !info.isDirectory() ||
    (process.getuid && info.uid !== process.getuid()) ||
    (process.platform !== "win32" && (info.mode & 0o077) !== 0)
  )
    throw new Error("Vector cache must be a private, owned directory.");
}

export async function maintainVectorCache(
  action: "status" | "prune" | "clear" = "prune",
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const policy = cachePolicy();
  const root = vectorCacheRoot();
  const records: {
    path: string;
    size: number;
    modified: number;
    temporary: boolean;
  }[] = [];
  const now = Date.now();
  const hash = /^[0-9a-f]{64}$/;
  let exists = false;
  async function walk(path: string, depth: number): Promise<void> {
    let directory;
    try {
      await assertPrivateCacheDirectory(path);
      directory = await opendir(path);
      exists = true;
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      )
        return;
      throw error;
    }
    for await (const entry of directory) {
      signal?.throwIfAborted();
      const child = join(path, entry.name);
      if (depth < 2 && hash.test(entry.name) && entry.isDirectory())
        await walk(child, depth + 1);
      if (depth !== 2 || !entry.isFile()) continue;
      const temporary = /^[0-9a-f]{64}\.json\.(\d+)\.[0-9a-f-]+\.tmp$/.exec(
        entry.name,
      );
      if (!/^[0-9a-f]{64}\.json$/.test(entry.name) && !temporary) continue;
      if (temporary) {
        try {
          process.kill(Number(temporary[1]), 0);
          continue;
        } catch (error) {
          if (!(
            error &&
            typeof error === "object" &&
            "code" in error &&
            error.code === "ESRCH"
          ))
            continue;
        }
      }
      try {
        const info = await lstat(child);
        if (info.isFile())
          records.push({
            path: child,
            size: info.size,
            modified: info.mtimeMs,
            temporary: !!temporary,
          });
      } catch (error) {
        if (!(
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "ENOENT"
        ))
          throw error;
      }
    }
  }
  await walk(root, 0);
  let bytes = records.reduce((sum, record) => sum + record.size, 0);
  let removed = 0;
  const beforeBytes = bytes;
  if (action !== "status") {
    records.sort((a, b) => a.modified - b.modified);
    for (const record of records) {
      signal?.throwIfAborted();
      if (
        action !== "clear" &&
        !record.temporary &&
        now - record.modified <= policy.maxAgeMs &&
        bytes <= policy.maxBytes
      )
        continue;
      try {
        const current = await lstat(record.path);
        if (
          !current.isFile() ||
          current.mtimeMs !== record.modified ||
          current.size !== record.size
        )
          continue;
        await unlink(record.path);
        bytes -= record.size;
        removed++;
      } catch (error) {
        if (!(
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "ENOENT"
        ))
          throw error;
      }
    }
  }
  return {
    root,
    exists,
    files: records.length,
    beforeBytes,
    bytes,
    removed,
    ...policy,
  };
}
