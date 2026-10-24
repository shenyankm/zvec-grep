import { execFile } from "node:child_process";
import { lstat, mkdir, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  BaseEmbeddingModel,
  type EmbeddingModel,
  type EmbeddingResult,
  type NormalizedEmbeddingOptions,
} from "../../models/index.js";
import type {
  Content,
  EmbeddingCacheStats,
  WorkspaceIndexInfo,
} from "../../types.js";
import { defaultHome } from "../../utils/path.js";
import { sha256Text as hash } from "../../utils/hash.js";
import { replaceFileAtomically } from "../../utils/atomic-file.js";

const exec = promisify(execFile);
type Entry = { vector: number[]; truncated: boolean };
const inFlight = new Map<string, Promise<Entry>>();

export async function repositoryEmbeddingCache(
  model: EmbeddingModel,
  workspace: WorkspaceIndexInfo,
  signal?: AbortSignal,
): Promise<{ model: EmbeddingModel; stats: EmbeddingCacheStats } | undefined> {
  // shortcut: remote mutable models and multi-root indexes bypass reuse; extend only with stable identities and per-root namespaces.
  if (!model.info.cacheIdentity || workspace.rootPaths.length !== 1) return;
  signal?.throwIfAborted();
  try {
    const root = workspace.rootPaths[0].absolutePath;
    const { stdout } = await exec(
      "git",
      ["-C", root, "rev-parse", "--path-format=absolute", "--git-common-dir"],
      {
        signal,
        timeout: 2000,
        maxBuffer: 64 * 1024,
        windowsHide: true,
        env: {
          ...process.env,
          GIT_DIR: undefined,
          GIT_WORK_TREE: undefined,
          GIT_COMMON_DIR: undefined,
          GIT_INDEX_FILE: undefined,
        },
      },
    );
    const common = await realpath(stdout.replace(/\r?\n$/, ""));
    const identity = hash(
      JSON.stringify([
        "node-document-v1",
        model.info.cacheIdentity,
        model.info.reference,
        model.info.provider,
        model.info.name,
        model.info.endpoint,
        model.info.dimension,
        model.info.metric,
        model.info.limits.maxInputTokens,
      ]),
    );
    // shortcut: no automatic eviction; add size/age limits when cache growth warrants it.
    const cacheRoot = join(defaultHome(), "embedding-cache-v1");
    const repository = join(cacheRoot, hash(common));
    const directory = join(repository, identity);
    for (const path of [cacheRoot, repository, directory]) {
      await mkdir(path, { recursive: true, mode: 0o700 });
      const info = await lstat(path);
      if (
        !info.isDirectory() ||
        (process.getuid && info.uid !== process.getuid()) ||
        (process.platform !== "win32" && (info.mode & 0o077) !== 0)
      )
        return;
    }
    signal?.throwIfAborted();
    const stats: EmbeddingCacheStats = { hits: 0, computed: 0, errors: 0 };
    return { model: new CachedDocumentModel(model, directory, stats), stats };
  } catch {
    signal?.throwIfAborted();
    // Cache discovery or permissions must not prevent ordinary indexing.
    return undefined;
  }
}

class CachedDocumentModel extends BaseEmbeddingModel {
  readonly info;
  constructor(
    private readonly model: EmbeddingModel,
    private readonly directory: string,
    private readonly stats: EmbeddingCacheStats,
  ) {
    super();
    this.info = model.info;
  }

  protected async doEmbed(
    contents: readonly Content[],
    options: NormalizedEmbeddingOptions,
  ): Promise<EmbeddingResult> {
    if (
      options.purpose !== "document" ||
      contents.some((content) => content.kind !== "text")
    )
      return this.model.embed(contents, options);
    options.signal?.throwIfAborted();
    const owned: {
      key: string;
      content: Content;
      resolve: (entry: Entry) => void;
      reject: (error: unknown) => void;
    }[] = [];
    const entries: Promise<Entry>[] = [];
    try {
      const keys = contents.map((content) => hash(JSON.stringify(content)));
      const records = await Promise.all(
        keys.map((key) => this.read(join(this.directory, `${key}.json`), key)),
      );
      // Reserve misses without awaiting so concurrent batches share one computation.
      for (const [index, content] of contents.entries()) {
        options.signal?.throwIfAborted();
        const key = keys[index];
        const path = join(this.directory, `${key}.json`);
        const cached = records[index];
        if (cached) {
          this.stats.hits++;
          entries.push(Promise.resolve(cached));
          continue;
        }
        let pending = inFlight.get(path);
        if (pending) {
          this.stats.hits++;
        } else {
          pending = new Promise<Entry>((resolve, reject) =>
            owned.push({ key, content, resolve, reject }),
          );
          void pending.catch(() => undefined);
          inFlight.set(path, pending);
        }
        entries.push(pending);
      }
      if (owned.length) {
        await this.model.prepare?.(options);
        const result = await this.model.embed(
          owned.map((item) => item.content),
          options,
        );
        options.signal?.throwIfAborted();
        if (
          !Array.isArray(result.vectors) ||
          result.vectors.length !== owned.length ||
          !Array.isArray(result.truncated) ||
          new Set(result.truncated).size !== result.truncated.length ||
          Array.from(result.truncated).some(
            (index) =>
              !Number.isInteger(index) || index < 0 || index >= owned.length,
          ) ||
          Array.from(result.vectors).some((vector) => !this.validVector(vector))
        ) {
          throw new Error("Embedding cache refused an invalid model result.");
        }
        this.stats.computed += owned.length;
        await Promise.all(
          owned.map(async (item, index) => {
            const entry = {
              vector: result.vectors[index],
              truncated: result.truncated.includes(index),
            };
            await this.write(item.key, entry);
            item.resolve(entry);
          }),
        );
      }
      const values = await waitForEntries(entries, options.signal);
      return {
        vectors: values.map((entry) => entry.vector.slice()),
        truncated: values.flatMap((entry, index) =>
          entry.truncated ? [index] : [],
        ),
      };
    } catch (error) {
      for (const item of owned) item.reject(error);
      throw error;
    } finally {
      for (const item of owned)
        inFlight.delete(join(this.directory, `${item.key}.json`));
    }
  }

  private validVector(vector: unknown): vector is number[] {
    return (
      Array.isArray(vector) &&
      vector.length === this.info.dimension &&
      Array.from(vector).every(
        (value) => typeof value === "number" && Number.isFinite(value),
      )
    );
  }

  private async read(path: string, key: string): Promise<Entry | undefined> {
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.size > this.info.dimension * 32 + 1024)
        throw new Error("Invalid cache record size.");
      const record = JSON.parse(await readFile(path, "utf8"));
      if (
        !record ||
        record.key !== key ||
        !this.validVector(record.vector) ||
        typeof record.truncated !== "boolean" ||
        record.digest !==
          hash(JSON.stringify([record.vector, record.truncated]))
      )
        throw new Error("Invalid cache record.");
      return { vector: record.vector, truncated: record.truncated };
    } catch (error) {
      if (!(
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      ))
        this.stats.errors++;
      return undefined;
    }
  }

  private async write(key: string, entry: Entry): Promise<void> {
    const target = join(this.directory, `${key}.json`);
    try {
      const record = {
        key,
        ...entry,
        digest: hash(JSON.stringify([entry.vector, entry.truncated])),
      };
      await replaceFileAtomically(target, JSON.stringify(record), {
        mode: 0o600,
      });
    } catch {
      this.stats.errors++;
    }
  }
}

async function waitForEntries(
  entries: Promise<Entry>[],
  signal?: AbortSignal,
): Promise<Entry[]> {
  signal?.throwIfAborted();
  if (!signal) return Promise.all(entries);
  let onAbort: () => void = () => undefined;
  try {
    return await Promise.race([
      Promise.all(entries),
      new Promise<never>((_resolve, reject) => {
        onAbort = () =>
          reject(
            signal.reason instanceof Error
              ? signal.reason
              : new Error("Embedding was cancelled."),
          );
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      }),
    ]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
