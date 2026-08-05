# Aliyun OpenAPI Pacing Fix Implementation Plan

> **Superseded:** The download-start pacing portions of this historical plan are replaced by `2026-08-05-aliyun-download-sliding-window.md`, whose final rule is a host-wide strict window of two starts per 60 seconds with the third call waiting internally.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent the fourth and fifth OpenClaw downloads from failing by pacing all Aliyun OpenAPI request starts below three requests per second.

**Architecture:** Extend the existing shared `AliyunOpenApiRateLimiter` with a FIFO-wide 350 ms minimum interval between consecutive OpenAPI starts. Keep the endpoint rolling windows, cancellation behavior, three-slot content-download gate, Skill 3+2 batching, and signed multipart PUT pacing unchanged.

**Tech Stack:** TypeScript 5.9, Node.js 24, Vitest fake timers, OpenClaw 2026.7.1-2.

## Global Constraints

- Every Aliyun OpenAPI HTTP start after the first must be at least 350 ms after the previous start, regardless of endpoint.
- Keep `openFile/list` at 40 starts per 10 seconds and `openFile/getDownloadUrl` at 10 starts per 10 seconds.
- Preserve FIFO ordering and remove an aborted waiter without sending its request or delaying the next eligible waiter.
- Do not add automatic retries or expose credentials, signed URLs, drive IDs, remote names, or absolute paths.
- Do not change multipart size, sequential signed PUT behavior, resource-drive-only routing, download destination semantics, or the three-slot download gate.
- Real-account verification is limited to one five-file download attempt with no new list call, retry, remote upload, remote deletion, or rate-limit pressure test.
- Preserve the existing user-owned `.gitignore` modification.

---

### Task 1: Add global OpenAPI start pacing

**Files:**
- Modify: `tests/unit/aliyun-rate-limiter.test.ts`
- Modify: `src/providers/aliyun/rate-limiter.ts`

**Interfaces:**
- Consumes: `AliyunOpenApiRateLimiter.acquire(endpointPath: string, signal?: AbortSignal): Promise<void>`.
- Produces: the same public interface with a process-local 350 ms FIFO start interval across every endpoint.

- [ ] **Step 1: Replace the obsolete fifteen-request burst assertion with a failing pacing test**

Add a test that records resolution times for mixed endpoints:

```ts
it("paces mixed OpenAPI starts at least 350 ms apart", async () => {
  const limiter = new AliyunOpenApiRateLimiter();
  const starts: number[] = [];
  const pending = [
    limiter.acquire(LIST_ENDPOINT),
    limiter.acquire(DOWNLOAD_URL_ENDPOINT),
    limiter.acquire(OTHER_ENDPOINT),
    limiter.acquire(OTHER_ENDPOINT),
  ].map((promise) => promise.then(() => starts.push(Date.now())));

  await vi.advanceTimersByTimeAsync(1_049);
  expect(starts).toEqual([0, 350, 700]);
  await vi.advanceTimersByTimeAsync(1);
  await Promise.all(pending);
  expect(starts).toEqual([0, 350, 700, 1_050]);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
npx vitest run tests/unit/aliyun-rate-limiter.test.ts
```

Expected: the new pacing assertion fails because the current limiter resolves the four mixed requests at time zero.

- [ ] **Step 3: Implement the minimum global start interval**

In `src/providers/aliyun/rate-limiter.ts`:

```ts
const GLOBAL_MIN_START_INTERVAL_MS = 350;
```

Track the last granted start time separately from the endpoint rolling-window arrays. In `#drain()`, include the remaining global interval in `waitMs`; after granting a waiter, set the last-start timestamp to the current clock value. Do not reserve a start time for an aborted waiter.

Because fake time begins at zero, represent "no prior start" with `undefined`, not a numeric sentinel:

```ts
#lastGlobalStart: number | undefined;

const globalIntervalWait = this.#lastGlobalStart === undefined
  ? 0
  : Math.max(0, this.#lastGlobalStart + GLOBAL_MIN_START_INTERVAL_MS - now);
```

Retain the existing endpoint window checks and combine all waits with `Math.max(...)`.

- [ ] **Step 4: Update FIFO and cancellation tests for paced starts**

Change setup calls that previously acquired 15 requests at time zero so they advance fake time by 350 ms per grant. Assert an aborted queued request is removed and the next request resolves at the next ordinary 350 ms boundary rather than receiving an extra delay.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run:

```powershell
npx vitest run tests/unit/aliyun-rate-limiter.test.ts tests/unit/aliyun-provider.test.ts tests/unit/aliyun-upload.test.ts
```

Expected: all selected tests pass with no unhandled timer or promise warnings.

- [ ] **Step 6: Run the complete repository gate**

Run:

```powershell
npm run verify
git diff --check
git status --short
```

Expected: typecheck, all unit and integration tests, build, and package dry-run pass; `git diff --check` is clean; only the pacing source/test changes and the pre-existing `.gitignore` modification are present.

- [ ] **Step 7: Commit the implementation locally**

```powershell
git add -- src/providers/aliyun/rate-limiter.ts tests/unit/aliyun-rate-limiter.test.ts
git commit -m "fix: pace Aliyun OpenAPI requests"
```

Expected: only the two task files are committed; `.gitignore` remains unstaged.

### Task 2: Install the exact package and perform one bounded live acceptance

**Files:**
- No tracked source changes.
- Generated artifact: a task-specific temporary `openclaw-plugin-sheen-pansync-0.1.6.tgz`.

**Interfaces:**
- Consumes: the committed rate limiter, OpenClaw plugin installer, managed Gateway, and the existing real-account session that already holds the sanitized root listing.
- Produces: fresh installed-package, Gateway, Tool-policy, and one-attempt five-file acceptance evidence.

- [ ] **Step 1: Materialize and identify the exact artifact**

Create a uniquely named directory below the operating-system temporary directory, run:

```powershell
npm pack --json --pack-destination $acceptanceRoot
Get-FileHash -Algorithm SHA256 -LiteralPath $tarball
```

Record only artifact name, byte length, and SHA-256. Do not copy credentials or runtime state into the artifact directory.

- [ ] **Step 2: Install and activate the exact artifact**

Run:

```powershell
openclaw plugins install "npm-pack:$tarball" --force
openclaw plugins enable sheen-pansync
openclaw gateway restart --safe
```

Keep legacy `pan-sync-helper` disabled. Do not alter the existing exact `tools.alsoAllow` entries.

- [ ] **Step 3: Verify the live runtime before cloud access**

Run:

```powershell
openclaw plugins inspect sheen-pansync --runtime --json
openclaw plugins doctor
openclaw gateway health
```

Expected: version `0.1.6`, no diagnostics, all three `pan_sync_*` Tool names registered, and Gateway health `OK`. Start a new Agent session with `/tools` and confirm the same three Tools are available under the effective policy.

- [ ] **Step 4: Execute exactly one five-file download journey**

Reuse the previously established sanitized root-list session and its five known files; do not call `pan_sync_list` again. Tell OpenClaw to call `pan_sync_download` in batches of three then two, wait for the first batch to finish, omit `localDirectory` from all calls, never retry, never read downloaded contents, and report only counts and stable status codes.

Before the Agent call, capture the local start time. After it returns, count new regular files in the workspace root without printing their names or paths.

Expected: five Tool calls, five `downloaded` results, zero failures, and five new root-level files. Collision-safe renamed files are acceptable.

- [ ] **Step 5: Stop on any live failure and perform final verification**

Do not repeat a failed live journey. Run fresh completion evidence:

```powershell
openclaw gateway health
openclaw plugins inspect sheen-pansync --runtime --json
git status --short
git log -3 --oneline
```

Report the automated gate, installed artifact hash, plugin/runtime state, exact live call/success/failure counts, workspace-root result, the unchanged `.gitignore`, and the fact that no remote deletion or pressure test occurred. Leave downloaded local files and any remote data untouched unless separately authorized.
