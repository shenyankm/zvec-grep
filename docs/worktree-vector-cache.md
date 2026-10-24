# Repository-scoped vector reuse (Node backend)

The Node/TypeScript engine reuses document embeddings between branches and linked Git worktrees. Each worktree keeps its own `.zvec-grep` index, file IDs, paths, scan state, deletion handling, and search results. Worktrees never share a writable Zvec collection.

```text
worktree A -> its own manifest + Zvec collection --+
                                                 +-> repository/user vector cache
worktree B -> its own manifest + Zvec collection --+
```

## Scope and identity

For a single-directory Git index, the canonical `git rev-parse --git-common-dir` identifies the repository. Linked worktrees resolve to the same directory. Unrelated repositories and separate clones do not share entries, even when their files or commit IDs match.

The cache is stored below:

```text
$ZVEC_GREP_HOME/embedding-cache-v1/<repository hash>/<model identity hash>/<input hash>.json
```

`ZVEC_GREP_HOME` defaults to `~/.zvec-grep`. New cache directories use mode `0700`; records use `0600`. On Unix, non-private or differently owned cache directories disable reuse instead of widening permissions. Symlink cache directories/records are not accepted. Use a private home/ACL on Windows and do not share this directory across users.

The model namespace includes an explicit weights/preprocessing identity, reference, provider, endpoint, dimension, metric, and input token limit. Built-in local backends supply an identity containing their pinned catalog/artifact revisions, backend settings, requested device, and implementation revision. **Bump that implementation revision when preprocessing, runtime dependencies, or numerical output semantics change.** Custom models must explicitly provide `EmbeddingModelInfo.cacheIdentity` to opt in.

Entries hash the complete prepared document input, including extraction metadata. The key is not a branch, HEAD, file name, or raw file hash. Changed scope/heading/signature inputs therefore cannot cross-hit even if the source body is unchanged. If extraction/chunking changes produce different inputs, those inputs miss naturally.

Built-in remote models do not opt in because a model alias/endpoint does not establish immutable weights. Query embeddings, image batches, non-Git directories, file roots, and multi-root indexes use the normal path. Existing authorization checks are unchanged. This implementation does not add reuse to the Rust backend.

## Lifecycle, concurrency, and fallback

- Hits restore both vectors and truncation flags, in original input order. A fully cached operation does not prepare/load the local inference model.
- Duplicate inputs and concurrent batches within one process share in-flight computations. Cancelling a follower does not cancel an independent owner. Failure or cancellation releases reservations for retry.
- Separate processes may compute the same simultaneous miss. UUID temporary files plus atomic rename prevent partial published records; there is no cross-process inference lock.
- Reads validate key, vector shape, finite values, truncation metadata, and a payload checksum. Corrupt/missing records recompute. Invalid fresh model results are rejected before publication.
- Cache discovery/write failures do not turn into a successful-but-empty index or block normal inference. Cache errors are counted, while model/storage failures retain their existing handling.
- Deleting or rebuilding a worktree index does not delete shared entries. Removing the cache only costs later recomputation; existing indexes are self-contained.
- There is no automatic eviction in this first version. Monitor disk usage and remove the disposable `embedding-cache-v1` directory when needed, preferably with indexing jobs stopped. No reference-count/GC state is needed because indexes retain their vectors.

## Statistics

The engine's `IndexResult.embeddingCache` reports:

- `hits`: document inputs reused from disk or in-flight work;
- `computed`: unique document inputs successfully inferred by this operation;
- `errors`: cache read/validation/write errors handled by fallback.

Counters describe embedding attempts during indexing, not the number of files or total stored fragments. The CLI prints a `vector cache` row. A completed, newly submitted MCP index request with `wait: true` includes optional `embedding_cache` statistics; a request joining another existing job may omit them. Daemon `index.completed` logs include primitive `vector_cache_*` fields. No statistics are fabricated for bypassed caches.

## Verification

```sh
npm run build
node --test --test-concurrency=1 \
  test/unit/embedding-cache.test.mjs \
  test/integration/worktree-cache.test.mjs \
  test/mcp-contract.test.mjs
# Run the full check without inheriting a developer's model defaults:
CHECK_HOME="$(mktemp -d)"
HOME="$CHECK_HOME" USERPROFILE="$CHECK_HOME" \
  ZVEC_GREP_HOME="$CHECK_HOME/.zvec-grep" npm run check
# Remove CHECK_HOME after the check; do not remove your normal home/cache.
```

Tests use temporary repositories, real linked worktrees, independent native Zvec collections, and a deterministic embedding fixture. They do not download model weights or modify real project indexes.

The acceptance fixture's first worktree infers two unique fragments (`computed: 2`); the second worktree reuses both (`hits: 2, computed: 0`). Additional assertions verify:

- concurrent worktrees infer a newly shared input only once in one process;
- uncommitted edits, added/deleted/renamed files, and branch switch-back stay correct;
- lexical search results and absolute paths never leak across worktrees;
- unrelated repositories do not consume one another's cached vectors;
- index deletion retains reusable vectors; cache deletion preserves search correctness;
- actual daemon completion and MCP serialization carry cache counters;
- revision, endpoint, dimensions, full contextual inputs, corruption, cancellation, malformed outputs, and concurrent process publication are handled safely.

Local acceptance on Darwin arm64 / Node v22.23.2 passed the full isolated `npm run check`: ESLint, Prettier, type checking, 456 root tests, 293 unit tests (292 pass, one Windows-only skip), 40 integration tests, nine end-to-end tests, and one package test. Total: 799 tests, 798 pass, one skip, zero failures. Overall source line coverage was 89.93% and branch coverage 85%; `embedding-cache.ts` had 100% line and 93.87% branch coverage. The state-display plugin's separate check also passed (159 pass, two Windows-only skips).

These are correctness and inference-count checks, not a production wall-clock speedup claim. Real speedups depend on input overlap, model cost, filesystem latency, and native index maintenance.
