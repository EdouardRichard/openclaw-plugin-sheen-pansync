# Aliyun Rate Limit and Transfer Path Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent Aliyun Drive throttling during multi-file downloads and multipart uploads while making the workspace root the default download destination unless the user explicitly supplies a local directory.

**Architecture:** Add one shared FIFO sliding-window limiter to each `AliyunAuthorizedClient`, one shared three-slot FIFO download semaphore to each `ReadOrchestrator`, and safe segment-by-segment creation for explicitly requested workspace-relative download directories. Replace multipart workers with one ascending loop using 20 MiB base parts and a 350 ms minimum PUT-start interval, then encode the same behavior in the packaged Pan Sync Skill.

**Tech Stack:** TypeScript 5.9, Node.js 22, Web Streams, Vitest 3, OpenClaw plugin/Skill packaging.

## Global Constraints

- All Aliyun OpenAPI quotas are enforced per in-process shared provider; cross-Gateway distributed limiting is out of scope.
- `openFile/list` permits at most 40 starts in a rolling 10 seconds; `openFile/getDownloadUrl` permits at most 10 starts in a rolling 10 seconds; other OpenAPI calls permit at most 15 starts in a rolling second.
- All OpenAPI calls additionally share a conservative plugin-side 15-start rolling one-second budget; this is not represented as an official global quota.
- Download streams use a FIFO capacity of three, held from before `getDownloadUrl` until the stream succeeds, fails, or is cancelled.
- An omitted `localDirectory` means the workspace root. A local directory is used only when the user explicitly supplied it, and is never derived from an Aliyun remote path.
- Explicit workspace-relative local directories are created safely; existing files are never overwritten and failure never recursively removes directories.
- Multipart upload sends `parallel_upload: false`, uploads one part at a time in ascending order, uses a 20 MiB base part, never exceeds 10,000 parts or 5 GB per part, and starts adjacent fast PUTs at least 350 ms apart.
- Preserve 64 KiB streaming reads, zero-byte behavior, 50-minute signed-URL refresh, one token refresh retry, stable error codes, cancellation, and sensitive-data redaction.
- Do not add automatic network retries or real-account rate-limit pressure tests.
- Preserve unrelated user changes, including the existing `.gitignore` modification. Do not commit, push, publish, or create a PR without separate authorization.

---

### Task 1: FIFO OpenAPI Sliding-Window Limiter

**Files:**
- Create: `src/providers/aliyun/rate-limiter.ts`
- Create: `tests/unit/aliyun-rate-limiter.test.ts`
- Modify: `src/providers/aliyun/upload.ts:30-177`
- Modify: `src/providers/aliyun/provider.ts:25-135`
- Modify: `tests/unit/aliyun-provider.test.ts:1-180`

**Interfaces:**
- Produces: `AliyunOpenApiRateLimiter.acquire(endpointPath: string, signal?: AbortSignal): Promise<void>`.
- Produces: `AliyunAuthorizedClientOptions.rateLimiter?` for deterministic unit injection; the default is one limiter owned by the client.
- Consumes: caller `AbortSignal`; cancellation rejects before `fetch` and removes the waiter from the FIFO queue.

- [ ] **Step 1: Write failing limiter tests**

Create focused fake-timer tests that enqueue calls without touching HTTP:

```ts
it("holds the eleventh getDownloadUrl start until the rolling 10-second window opens", async () => {
  vi.useFakeTimers();
  const limiter = new AliyunOpenApiRateLimiter();
  await Promise.all(Array.from({ length: 10 }, () =>
    limiter.acquire("/adrive/v1.0/openFile/getDownloadUrl")));
  let started = false;
  const eleventh = limiter.acquire("/adrive/v1.0/openFile/getDownloadUrl")
    .then(() => { started = true; });
  await vi.advanceTimersByTimeAsync(9_999);
  expect(started).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  await eleventh;
  expect(started).toBe(true);
});
```

Also cover the 41st `list` request, the 16th mixed-endpoint request in one second, FIFO order, and aborting a queued request without delaying the next waiter.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npx vitest run tests/unit/aliyun-rate-limiter.test.ts`

Expected: FAIL because `src/providers/aliyun/rate-limiter.ts` and `AliyunOpenApiRateLimiter` do not exist.

- [ ] **Step 3: Implement the minimal FIFO limiter**

Use a single queue so multiple scopes are reserved atomically. Each queue head selects these timestamp arrays:

```ts
const GLOBAL = { limit: 15, windowMs: 1_000 };
const LIST = { limit: 40, windowMs: 10_000 };
const DOWNLOAD_URL = { limit: 10, windowMs: 10_000 };
```

Prune timestamps at or before `now - windowMs`, compute the maximum wait across the global rule and endpoint-specific rule, record all applicable starts only when the head is admitted, and schedule exactly one wake-up timer. An aborted waiter is removed, its listener is detached, and the next head is drained immediately. Never log endpoint bodies, tokens, or signed URLs.

- [ ] **Step 4: Verify limiter GREEN**

Run: `npx vitest run tests/unit/aliyun-rate-limiter.test.ts`

Expected: PASS with fake timers; no test waits for wall-clock quota windows.

- [ ] **Step 5: Write failing authorized-client integration tests**

Add tests proving `AliyunAuthorizedClient.post()` acquires before every actual HTTP attempt, including the one permitted access-token retry:

```ts
expect(rateLimiter.acquire).toHaveBeenNthCalledWith(
  2,
  "/adrive/v1.0/example",
  controller.signal,
);
expect(fetch).toHaveBeenCalledTimes(2);
```

Add a queued-abort test asserting `fetch` is never called and the stable operation failure code is returned.

- [ ] **Step 6: Run the authorized-client tests and verify RED**

Run: `npx vitest run tests/unit/aliyun-provider.test.ts -t "rate limiter|token failure retry"`

Expected: FAIL because `AliyunAuthorizedClient` does not acquire a permit.

- [ ] **Step 7: Integrate the limiter into `AliyunAuthorizedClient`**

Create one default limiter in the constructor and call:

```ts
await this.#rateLimiter.acquire(endpointPath, options.signal);
```

immediately before each `fetch` inside the retry loop. Pass the provider clock into the default limiter only through a monotonic-compatible `now` option used by tests; production remains `Date.now`. Collapse unexpected limiter errors through the requested stable failure code, while preserving `PanSyncError` results such as cancellation mappings.

- [ ] **Step 8: Run focused and adjacent provider tests**

Run: `npx vitest run tests/unit/aliyun-rate-limiter.test.ts tests/unit/aliyun-provider.test.ts tests/unit/aliyun-read.test.ts`

Expected: PASS.

---

### Task 2: Three-Slot Download Lifecycle Gate

**Files:**
- Create: `src/read/download-concurrency.ts`
- Create: `tests/unit/download-concurrency.test.ts`
- Modify: `src/read/orchestrator.ts:18-245`
- Modify: `tests/unit/read-orchestrator.test.ts:70-650`

**Interfaces:**
- Produces: `FifoDownloadGate.acquire(signal?: AbortSignal): Promise<() => void>` with constructor capacity defaulting to three.
- Consumes: one gate instance owned by `ReadOrchestrator`; the returned release callback is idempotent.

- [ ] **Step 1: Write failing gate unit tests**

Test three immediate admissions, FIFO admission of fourth and fifth only after releases, idempotent release, and abort removal:

```ts
const releases = await Promise.all([gate.acquire(), gate.acquire(), gate.acquire()]);
const order: number[] = [];
const fourth = gate.acquire().then((release) => { order.push(4); return release; });
const fifth = gate.acquire().then((release) => { order.push(5); return release; });
expect(order).toEqual([]);
releases[0]();
expect(await fourth).toBeTypeOf("function");
expect(order).toEqual([4]);
```

- [ ] **Step 2: Run the gate test and verify RED**

Run: `npx vitest run tests/unit/download-concurrency.test.ts`

Expected: FAIL because the gate module does not exist.

- [ ] **Step 3: Implement the minimal cancelable FIFO gate**

Maintain `active`, a FIFO waiter array, and a `drain()` method. Reject an already-aborted or queued-aborted acquisition with `PanSyncError("DOWNLOAD_FAILED")`; detach abort listeners on admission; return an idempotent release that decrements once and drains the next waiter.

- [ ] **Step 4: Verify gate GREEN**

Run: `npx vitest run tests/unit/download-concurrency.test.ts`

Expected: PASS.

- [ ] **Step 5: Write the five-download reproduction test**

In `read-orchestrator.test.ts`, use one orchestrator and five distinct entries. Make `openDownload` return streams controlled by deferred close signals. Start all five downloads and assert:

```ts
expect(openDownload).toHaveBeenCalledTimes(3);
expect(maximumActiveStreams).toBe(3);
// Close one stream, then wait for only the fourth call.
expect(openDownload).toHaveBeenCalledTimes(4);
```

Finish all streams and assert all five return `status: "downloaded"`. Add failure and queued-cancellation cases proving a slot is always released and an aborted queued call never reaches `openDownload` or creates a file.

- [ ] **Step 6: Run the orchestrator reproduction and verify RED**

Run: `npx vitest run tests/unit/read-orchestrator.test.ts -t "five concurrent downloads|download slot"`

Expected: FAIL because all five calls currently enter `openDownload`.

- [ ] **Step 7: Hold a permit around the complete remote stream lifecycle**

Resolve metadata and large-file confirmation before acquiring. Then structure the download section as:

```ts
const release = await this.#downloadGate.acquire(options.signal);
try {
  target = await openWorkspaceDownloadTarget(...);
  const download = await provider.openDownload(...);
  // validate and stream the full file
} finally {
  release();
}
```

Keep existing cleanup and stable error behavior. The permit must be acquired before local target creation and before `getDownloadUrl`, and released for success, provider failure, short/long streams, write failure, and cancellation.

- [ ] **Step 8: Run all read-orchestrator tests**

Run: `npx vitest run tests/unit/download-concurrency.test.ts tests/unit/read-orchestrator.test.ts`

Expected: PASS.

---

### Task 3: Safe Creation of User-Specified Download Directories

**Files:**
- Modify: `src/workspace/download-target.ts:1-170`
- Modify: `tests/unit/download-target.test.ts:1-320`
- Modify: `src/read/tool.ts:16-46`
- Modify: `tests/integration/tool.test.ts`

**Interfaces:**
- Preserves: `openWorkspaceDownloadTarget(workspaceDir, localDirectory, remoteName)`.
- Changes: a valid missing relative `localDirectory` is created segment by segment; omitted input continues to use the workspace root.

- [ ] **Step 1: Replace the old missing-directory expectation with failing creation tests**

Test `reports/2026` creation and file placement, concurrent creation of the same directory, no directory derivation when `localDirectory` is omitted, and rejection of traversal/absolute/control-character/symlink escape inputs. Assert cleanup deletes only the incomplete file and leaves created directories present.

```ts
const target = await openWorkspaceDownloadTarget(
  workspace,
  "reports/2026",
  "report.pdf",
);
expect(target.relativePath).toBe("reports/2026/report.pdf");
await expect(stat(path.join(workspace, "reports", "2026")))
  .resolves.toMatchObject({ isDirectory: expect.any(Function) });
```

- [ ] **Step 2: Run download-target tests and verify RED**

Run: `npx vitest run tests/unit/download-target.test.ts`

Expected: FAIL with `WORKSPACE_PATH_REJECTED` for the new missing nested directory case.

- [ ] **Step 3: Implement safe segment-by-segment directory creation**

Import `mkdir`. After validating the relative path, split on both separators and for each non-empty segment:

1. Build the next lexical path under `workspace.lexical`.
2. Call `mkdir(next)` without `recursive`; accept only `EEXIST` races.
3. Resolve `realpath(next)`, require a directory, and require containment under `workspace.canonical`.
4. Continue from the lexical child only after the canonical containment check.

Do not remove any directory during cleanup. Preserve collision-safe `open(..., "wx", 0o600)` behavior.

- [ ] **Step 4: Update Tool wording and integration assertions**

Change the public `localDirectory` description to state: omitted means workspace root; supplied values are user-requested workspace-relative directories and missing directories are created. Add an integration assertion that the Tool forwards no `localDirectory` when omitted and that no remote path is converted into one.

- [ ] **Step 5: Run path and Tool tests**

Run: `npx vitest run tests/unit/download-target.test.ts tests/integration/tool.test.ts`

Expected: PASS.

---

### Task 4: Sequential Multipart Upload with Conservative PUT Starts

**Files:**
- Modify: `src/providers/aliyun/upload.ts:10-520`
- Modify: `src/providers/aliyun/provider.ts:25-135`
- Modify: `tests/unit/aliyun-upload.test.ts:260-700`

**Interfaces:**
- Changes: `parallel_upload` becomes `false`; `uploadParts` becomes one ascending loop.
- Produces: an injectable abort-aware delay function for deterministic tests, defaulting to `setTimeout`.
- Preserves: 20 MiB base part, 64 KiB reads, 10,000-part maximum, 50-minute URL refresh, token propagation, and zero-byte completion.

- [ ] **Step 1: Write failing sequential-upload tests**

Change the 45 MiB request expectation to `parallel_upload: false`. Replace the three-worker test with assertions that maximum active PUTs is one and observed order is `put-1-start`, `put-1-end`, `put-2-start`, `put-2-end`, etc. Change first-failure expectations so only part one starts and `complete` is absent.

Add a deterministic start-throttle test using injected `clock` and `delay`:

```ts
expect(putStartedAt).toEqual([0, 350, 700]);
expect(delays).toEqual([350, 350]);
```

Add a slow-PUT case where the clock advances by at least 350 ms during `fetch` and no extra delay occurs. Add an oversized-part case that rejects before create when `ceil(size / 10_000) > 5 * 1024 ** 3`.

- [ ] **Step 2: Run focused upload tests and verify RED**

Run: `npx vitest run tests/unit/aliyun-upload.test.ts -t "parallel_upload|sequential|PUT start|part size|first failure"`

Expected: FAIL because create still enables parallel upload and the worker pool starts three PUTs.

- [ ] **Step 3: Implement the abort-aware PUT-start delay**

Add:

```ts
const MAX_PART_SIZE = 5 * 1024 * 1024 * 1024;
const PUT_START_INTERVAL_MS = 350;
type AliyunDelay = (milliseconds: number, signal: AbortSignal) => Promise<void>;
```

The default delay rejects on abort, clears its timer, and detaches its listener. Thread an optional test delay from `AliyunProviderOptions` to `uploadAliyunFile` without exposing it in Tool schemas.

- [ ] **Step 4: Replace multipart workers with one ascending loop**

For each sorted part: stop on caller abort, refresh its URL at 50 minutes when needed, wait only for `max(0, previousPutStart + 350 - clock())`, record the start immediately before `putPart`, stream the exact byte range, and continue only after success. Remove `MAX_CONCURRENT_PUTS`, the shared worker cancellation controller, and fallback parallel behavior. Set `parallel_upload: false`.

Before create, compute `partSize = max(20 MiB, ceil(fileSize / 10_000))`; reject `UPLOAD_FAILED` when it exceeds 5 GB. Keep zero-byte uploads at zero parts and no PUT.

- [ ] **Step 5: Run all upload tests**

Run: `npx vitest run tests/unit/aliyun-upload.test.ts`

Expected: PASS; the fixture reports `maxConcurrentPuts() === 1`.

---

### Task 5: Skill Behavior TDD and Packaged Guidance

**Files:**
- Modify: `skills/pan-sync-upload/SKILL.md`
- Modify: `tests/integration/package.test.ts`
- Modify: `tests/integration/tool.test.ts:708-790`
- Create: `docs/superpowers/skill-tests/2026-08-05-pan-sync-download-baseline.md`
- Create: `docs/superpowers/skill-tests/2026-08-05-pan-sync-download-guided.md`

**Interfaces:**
- Produces: agent instructions for three-at-a-time folder downloads, explicit-only `localDirectory`, default workspace root, and no tight retry loop.
- Consumes: existing `pan_sync_list` and single-file `pan_sync_download` Tools; no new batch Tool is added.

- [ ] **Step 1: Run baseline Skill pressure scenarios before editing**

Following `superpowers:writing-skills`, run fresh-context scenarios without the proposed new wording. Include at least these combined pressures:

1. “Download `/资料/五个文件` quickly; preserve its cloud folder layout locally even though I did not state a local directory.”
2. “Launch all five downloads together; if the fourth fails, retry immediately until it works.”
3. “The destination folder `deliveries/today` does not exist; avoid creating folders and pick another path.”

Record the exact proposed Tool-call shapes and rationalizations in the baseline file. The expected RED signal is any inferred `localDirectory`, more than three simultaneous download calls, immediate retry loop, or refusal to use an explicitly supplied missing relative directory.

- [ ] **Step 2: Add failing repository assertions for the required Skill contract**

Assert the source Skill and packed artifact contain unambiguous phrases covering:

```text
user did not explicitly specify a local directory -> omit localDirectory
never derive localDirectory from remoteDirectory or remotePath
at most three pan_sync_download calls per batch; await the batch
do not immediately retry RATE_LIMITED, DOWNLOAD_FAILED, or UPLOAD_FAILED
```

Run: `npx vitest run tests/integration/tool.test.ts tests/integration/package.test.ts -t "Skill|localDirectory|download batch"`

Expected: FAIL because current Skill has no batch limit and does not prohibit inferred remote-path destinations strongly enough.

- [ ] **Step 3: Make the minimal Skill edit**

Add a short “Folder and multi-file download” contract. State the positive conditional behavior first:

```markdown
- If the user did not explicitly specify a local workspace directory, omit `localDirectory` on every call; each file goes to the workspace root.
- If the user explicitly specified a workspace-relative directory, pass exactly that directory; the Tool creates it when missing.
- For multiple files, issue at most three `pan_sync_download` calls in one batch and await all results before starting the next batch.
```

Then explicitly state that remote paths never choose the local directory and that the listed stable failures are reported without a tight retry loop. Keep single-file Tool semantics and the existing 100 MiB confirmation flow.

- [ ] **Step 4: Run guided pressure scenarios with the edited Skill**

Run the same fresh-context scenarios with the complete edited Skill. Record outputs in the guided file. Success requires consistent omission/preservation of `localDirectory`, batches of `3 + 2`, no immediate retries, and acceptance of explicitly supplied missing directories. If a new loophole appears, tighten only the failing wording and repeat.

- [ ] **Step 5: Verify Skill source and package tests**

Run: `npx vitest run tests/integration/tool.test.ts tests/integration/package.test.ts`

Expected: PASS, including inspection of the materialized npm artifact rather than only the source tree.

---

### Task 6: Full Verification and Review

**Files:**
- Modify only if verification exposes a requirement regression in the files already listed above.

**Interfaces:**
- Consumes all completed tasks.
- Produces a verified working tree ready for user inspection; no Git commit or remote action.

- [ ] **Step 1: Run focused regression suites together**

Run:

```powershell
npx vitest run tests/unit/aliyun-rate-limiter.test.ts tests/unit/aliyun-provider.test.ts tests/unit/aliyun-upload.test.ts tests/unit/download-concurrency.test.ts tests/unit/read-orchestrator.test.ts tests/unit/download-target.test.ts tests/integration/tool.test.ts tests/integration/package.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run typecheck and complete verification**

Run:

```powershell
npm run typecheck
npm run verify
```

Expected: both exit 0; unit tests, integration tests, and `npm pack --dry-run` all pass.

- [ ] **Step 3: Inspect the materialized package**

Run the repository's existing package-fixture/materialization test or `npm pack` through its established helper with inherited dry-run state cleared. Confirm the archive contains the edited `skills/pan-sync-upload/SKILL.md` and no secrets, temporary test records, or absolute workspace paths.

- [ ] **Step 4: Run final diff checks**

Run:

```powershell
git diff --check
git status --short
git diff -- src tests skills docs/superpowers
```

Expected: no whitespace errors; `.gitignore` remains an unrelated user modification; no generated package or test artifacts remain in the workspace.

- [ ] **Step 5: Apply verification-before-completion**

Use `superpowers:verification-before-completion`, report exact commands and outcomes, distinguish automated verification from unperformed real-account acceptance, and do not claim the fourth/fifth live downloads are fixed until the user or an authorized real-account run confirms them.
