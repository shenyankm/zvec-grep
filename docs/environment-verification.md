# Node backend environment acceptance

The executable fixtures are in `test/environments/`:

```sh
npm run test:environments
```

This builds the backend and runs the process-fault and load tests with explicit GC enabled. It requires an installed sibling `pi-zvec-status` checkout for the actual legacy HTTP MCP client. Tests use private temporary directories, deterministic inference, real linked worktrees, independent native Zvec collections, and an isolated loopback daemon. They do not restart or cancel the developer's shared daemon.

## Passing local experiments

Host: Darwin arm64, Node v22.23.2.

- 20 real Git worktrees; four native indexes with 256 source files each. Cold computation was 256 inputs; the other native indexes each reused 256 and computed none.
- 10,000 dense 1,024-dimensional vectors, 200,000 warm reuses, and 40 actual HTTP daemon status calls at concurrency four. A representative passing run took 62.78 seconds, with 222,625,922 cache bytes, 617.5 MiB peak RSS and 0.2 MiB retained JS heap growth after GC. The script emits its measurements on every run; timing/RSS are observations, not CI performance gates.
- Actual SIGKILL before atomic rename preserves the previous published record and permits stale-temp cleanup.
- Actual SIGKILL during inference allows a follower to reclaim the dead owner's per-input lease.
- Real read-only permissions force publication fallback without losing returned vectors.
- Cache clear is checked independently from native-index search: indexes remain usable.

Ordinary regression tests additionally cover default budgets/retention, safe CLI cleanup, ignored-parent inheritance, full/targeted/watcher selection, concurrent deduplication, cancellation, malformed vectors and cache corruption. `git check-ignore` supplies the reference for the new inheritance cases.

The companion plugin's real Pi PTY tests exercise regular/dark and fullscreen/light modes, keyboard cancellation, worktree overview, resizing, disconnect recovery and one actual 31-second stop/resume. Its [full environment report](https://github.com/shenyankm/pi-zvec-status/blob/main/docs/environment-verification.md) distinguishes physical experiments from unit tests and unsupported platforms.

## Ordinary checks

The current backend build passes 809 ordinary tests in aggregate (808 pass, one Windows-specific skip), including the installed-package check. Merged coverage is 90.71% lines, 85.88% branches and 95.51% functions; all four global 80% gates pass. Lint, formatting and typechecking pass.

A monolithic `npm run check` hit actual host `ENOSPC` after its 456-test root phase passed. It is not claimed to have passed. Remaining suites were rerun with per-file disposable HOME directories to bound temporary storage, and coverage for the unchanged build was merged with installed Istanbul tooling. Two additional cache cleanup-boundary tests passed afterward. The accidental space failure does not constitute controlled disk-full recovery validation; no project index or model cache was deleted to free space.

## Scope limits

No production Qwen model latency benchmark, hours-long soak, physical power cut, literal disk-full test, Windows/UNC/ACL run or network-filesystem test was performed on this Mac. The load fixture requires at least 1 GiB temporary free space and otherwise skips. No test intentionally fills the host disk.

The cache budget is enforced by maintenance, not a hard filesystem quota. Active/cancelled concurrent work can temporarily exceed it; lease I/O errors or a 30-second wait cap may permit redundant inference. Mutable remote models, multi-root/separate-clone reuse and the Rust backend remain outside this Node implementation.
