# Aliyun Download Sliding Window Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce a fail-closed, host-wide maximum of two Aliyun complete-download starts per rolling 60 seconds while keeping each Tool call pending until its own download can continue.

**Architecture:** Keep the existing process-local FIFO lifecycle gate, then add a separate persistent start limiter immediately before `getDownloadUrl`. A small coordinator owns cancellation and waiting; a Node `node:sqlite` Worker performs one short `BEGIN IMMEDIATE` reservation transaction per attempt against the plugin-owned `download-rate-limit.sqlite`, so all sessions and Gateway processes sharing one OpenClaw state directory observe the same window.

**Tech Stack:** TypeScript 5.9, Node.js built-in `node:sqlite` and `worker_threads`, Vitest 3.2, OpenClaw 2026.7.1-2, PowerShell.

## Global Constraints

- Production limit is exactly two committed download starts per 60,000 ms plus a 250 ms local release guard.
- The deployment guarantee covers one host, one OpenClaw state directory, any number of sessions, and any number of Gateway processes sharing that directory.
- Keep the existing capacity-one FIFO download lifecycle gate; the SQLite limiter controls frequency, not stream concurrency.
- Reserve a start immediately before `getDownloadUrl`; no permit means no `getDownloadUrl` or content GET.
- A committed permit remains consumed after remote failure, local failure, cancellation, Worker death, or Gateway restart.
- Waiting happens inside the original Tool call. Do not return a normal retry result and do not ask the AI to issue a duplicate call.
- Keep one non-Range content GET, resource-drive-only routing, collision-safe workspace downloads, large-file confirmation, no automatic retries, and existing stable public error codes.
- SQLite coordination failure maps to `DOWNLOAD_FAILED` and fails closed without exposing database, SQL, Worker, credential, identifier, URL, path, or raw-response details.
- Use a separate `pan-sync-helper/locks/download-rate-limit.sqlite`; do not access OpenClaw databases, other plugins' databases, or the existing `lease.sqlite` Token lease database.
- Do not add Redis, `sqlite3`, `better-sqlite3`, or any other runtime dependency. Continue using Node's built-in `node:sqlite` under the existing `node >=22.22.3` engine floor.
- Do not modify the user-owned `.gitignore` change. Do not commit, push, publish, create a PR, or delete remote files without separate authorization.
- Real acceptance is authorized only after automated checks pass and is limited to one bounded three-file download journey with no retry or rate-limit pressure test.

---

## File Structure

- Create `src/providers/aliyun/download-start-limiter.ts`: pure wait-loop, cancellation, clock-boundary validation, and stable fail-closed mapping.
- Create `src/providers/aliyun/sqlite-download-start-store.ts`: plugin-owned Worker protocol and atomic SQLite reservation store.
- Create `tests/unit/aliyun-download-start-limiter.test.ts`: deterministic coordinator tests with fake time/store.
- Create `tests/unit/sqlite-download-start-store.test.ts`: Worker protocol, permissions, failure, and cancellation unit tests.
- Create `tests/helpers/sqlite-download-start-child.mjs`: independent process driver for the compiled reservation store.
- Create `tests/helpers/sqlite-download-start-inspect.mjs`: read-only, sanitized timestamp inspector used by process tests and live acceptance.
- Create `tests/integration/sqlite-download-start-process.test.ts`: built-artifact, cross-process, restart-persistence tests.
- Modify `src/providers/aliyun/provider.ts`: require and acquire a download-start limiter before `getDownloadUrl`.
- Modify `src/runtime-composition.ts`: construct the SQLite store and limiter using the exact plugin data path.
- Modify `src/index.ts`: expose a test-only download-store factory injection alongside the existing credential lease factory.
- Modify provider construction helpers in `tests/unit/aliyun-read.test.ts`, `tests/unit/aliyun-provider.test.ts`, `tests/unit/aliyun-upload.test.ts`, `tests/integration/admin-server.test.ts`, and `tests/integration/leakage.test.ts`.
- Modify `tests/integration/plugin-entry.test.ts`: assert the independent database path and single shared runtime composition.
- Modify `src/read/tool.ts`, `skills/pan-sync-upload/SKILL.md`, `README.md`, `tests/integration/tool.test.ts`, and `tests/integration/package.test.ts`: encode internal waiting and no-duplicate-call behavior.
- Create `docs/superpowers/verification/2026-08-05-aliyun-download-sliding-window-acceptance.md` only after verification, containing sanitized automated and live evidence.

---

### Task 1: Implement the deterministic download-start wait coordinator

**Files:**
- Create: `src/providers/aliyun/download-start-limiter.ts`
- Create: `tests/unit/aliyun-download-start-limiter.test.ts`

**Interfaces:**
- Produces:

```ts
export const DOWNLOAD_START_LIMIT = 2;
export const DOWNLOAD_START_WINDOW_MS = 60_000;
export const DOWNLOAD_START_GUARD_MS = 250;
export const DOWNLOAD_START_MAX_WAIT_MS = 60_250;

export type DownloadStartReservation =
  | { status: "granted" }
  | { status: "wait"; waitMs: number };

export type DownloadStartReservationStore = {
  reserve(nowMs: number, signal?: AbortSignal): Promise<DownloadStartReservation>;
};

export type DownloadStartDelay = (
  milliseconds: number,
  signal?: AbortSignal,
) => Promise<void>;

export class AliyunDownloadStartLimiter {
  constructor(options: {
    store: DownloadStartReservationStore;
    clock?: () => number;
    delay?: DownloadStartDelay;
  });
  acquire(signal?: AbortSignal): Promise<void>;
}
```

- Consumes: only the `DownloadStartReservationStore` contract; it has no SQLite or Provider knowledge.

- [ ] **Step 1: Write failing coordinator tests**

Create deterministic tests that use a scripted store and fake delay. Cover immediate grant, one or more waits followed by grant, cancellation before the first reservation, cancellation during delay, store rejection, non-finite/negative wait values, and a wait above `60_250` ms.

Use assertions equivalent to:

```ts
const reserve = vi.fn()
  .mockResolvedValueOnce({ status: "wait", waitMs: 42_000 })
  .mockResolvedValueOnce({ status: "granted" });
const delay = vi.fn(async () => undefined);
const limiter = new AliyunDownloadStartLimiter({
  store: { reserve },
  clock: () => 1_000,
  delay,
});

await limiter.acquire();
expect(delay).toHaveBeenCalledWith(42_000, undefined);
expect(reserve).toHaveBeenNthCalledWith(1, 1_000, undefined);
expect(reserve).toHaveBeenCalledTimes(2);
```

For every internal failure assertion, require only:

```ts
await expect(limiter.acquire()).rejects.toMatchObject({
  code: "DOWNLOAD_FAILED",
  message: "DOWNLOAD_FAILED",
});
```

- [ ] **Step 2: Run the new tests and verify RED**

```powershell
npx vitest run tests/unit/aliyun-download-start-limiter.test.ts
```

Expected: FAIL because `download-start-limiter.ts` does not exist.

- [ ] **Step 3: Implement the minimal coordinator**

Implement an abortable default delay with `setTimeout`, remove its abort listener on every settlement path, and throw only `new PanSyncError("DOWNLOAD_FAILED")` across the public boundary.

The loop must follow this exact control flow:

```ts
for (;;) {
  if (signal?.aborted === true) throw new PanSyncError("DOWNLOAD_FAILED");
  const reservation = await store.reserve(clock(), signal);
  if (reservation.status === "granted") return;
  if (
    !Number.isFinite(reservation.waitMs)
    || reservation.waitMs < 0
    || reservation.waitMs > DOWNLOAD_START_MAX_WAIT_MS
  ) {
    throw new PanSyncError("DOWNLOAD_FAILED");
  }
  await delay(Math.max(1, Math.ceil(reservation.waitMs)), signal);
}
```

Wrap store and delay exceptions so raw messages never escape. Do not add retry counts: each loop is one reservation recheck after an intentional local wait, not a network retry.

- [ ] **Step 4: Verify coordinator GREEN**

```powershell
npx vitest run tests/unit/aliyun-download-start-limiter.test.ts
npm run typecheck
```

Expected: all coordinator tests pass and TypeScript reports no errors.

- [ ] **Step 5: Review checkpoint**

```powershell
git diff --check -- src/providers/aliyun/download-start-limiter.ts tests/unit/aliyun-download-start-limiter.test.ts
git status --short
```

Expected: only Task 1 files plus the pre-existing `.gitignore` and approved design/plan documents are changed; nothing is staged or committed.

---

### Task 2: Add the atomic SQLite reservation store

**Files:**
- Create: `src/providers/aliyun/sqlite-download-start-store.ts`
- Create: `tests/unit/sqlite-download-start-store.test.ts`

**Interfaces:**
- Consumes: `DownloadStartReservation` and `DownloadStartReservationStore` from Task 1.
- Produces:

```ts
export interface SqliteDownloadStartWorker {
  on(event: string, listener: (...args: any[]) => void): unknown;
  off(event: string, listener: (...args: any[]) => void): unknown;
  terminate(): Promise<number>;
}

export type SqliteDownloadStartWorkerFactory = (options: {
  databasePath: string;
  limit: number;
  windowMs: number;
  guardMs: number;
  rollbackToleranceMs: number;
  busyTimeoutMs: number;
  cancellationBuffer: SharedArrayBuffer;
}) => SqliteDownloadStartWorker;

export function createSqliteWorkerDownloadStartStore(
  databasePath: string,
  options?: {
    workerFactory?: SqliteDownloadStartWorkerFactory;
    limit?: number;
    windowMs?: number;
    guardMs?: number;
  },
): DownloadStartReservationStore;
```

- [ ] **Step 1: Write failing Worker-store tests**

Model fake Workers after `tests/unit/sqlite-worker-lease.test.ts`. Cover:

- exact Worker options and database path;
- `{ type: "granted" }` mapping to `{ status: "granted" }`;
- `{ type: "wait", waitMs: 12_345 }` mapping to `{ status: "wait", waitMs: 12_345 }`;
- malformed, duplicate, `messageerror`, `error`, and non-zero-exit events mapping to `DOWNLOAD_FAILED`;
- already-aborted and in-flight-aborted calls terminating the Worker;
- directory mode `0700` and database mode `0600` where POSIX modes apply.

Do not assert raw Worker errors. Assert only the stable `DOWNLOAD_FAILED` shape.

- [ ] **Step 2: Verify Worker store RED**

```powershell
npx vitest run tests/unit/sqlite-download-start-store.test.ts
```

Expected: FAIL because the SQLite store module does not exist.

- [ ] **Step 3: Implement the Worker protocol and atomic SQL**

Use `Worker` with an embedded `WORKER_SOURCE`, consistent with the existing credential lease implementation. Inside the Worker:

```js
const { DatabaseSync } = require("node:sqlite");
database = new DatabaseSync(workerData.databasePath, {
  timeout: workerData.busyTimeoutMs,
});
database.exec(`
  CREATE TABLE IF NOT EXISTS download_starts (
    id INTEGER PRIMARY KEY,
    started_at_ms INTEGER NOT NULL
  ) STRICT
`);
database.exec("BEGIN IMMEDIATE");
```

Define the private production constant `CLOCK_ROLLBACK_TOLERANCE_MS = 5_000`. Within the same transaction:

1. After `BEGIN IMMEDIATE` succeeds, capture `transactionNowMs = Date.now()`. Never use the pre-lock reservation-call time for pruning, waiting, or insertion.
2. Delete rows whose `started_at_ms + windowMs + guardMs <= transactionNowMs`.
3. If the newest remaining row is up to 5,000 ms in the future, preserve it, insert nothing, commit, and return one full conservative wait of `windowMs + guardMs` (60,250 ms by default).
4. If the newest row is more than 5,000 ms in the future, roll back and fail closed as `DOWNLOAD_FAILED`.
5. Otherwise count remaining rows. If count is below `limit`, insert `transactionNowMs`, commit, then post `{ type: "granted" }`.
6. Otherwise read `MIN(started_at_ms)`, calculate `waitMs = oldest + windowMs + guardMs - transactionNowMs`, commit, then post `{ type: "wait", waitMs }`.
7. On every failure, roll back if necessary, close the database, and post only `{ type: "failed" }`.

Check the shared cancellation flag before opening, before beginning the transaction, before insert/commit, and after lock contention. Never sleep while the transaction is open. Use a bounded busy loop with 200 ms SQLite slices and an overall 30-second acquisition deadline, matching the established credential-lease safety model.

- [ ] **Step 4: Enforce private paths and fail-closed cleanup**

Before starting a Worker, create only `path.dirname(databasePath)` with mode `0o700`, then `chmod` it. After a successful Worker response, `chmod(databasePath, 0o600)` before returning the reservation. If directory creation, chmod, Worker construction, protocol, exit, or database chmod fails, terminate the Worker and throw `new PanSyncError("DOWNLOAD_FAILED")`.

- [ ] **Step 5: Verify SQLite store GREEN**

```powershell
npx vitest run tests/unit/sqlite-download-start-store.test.ts tests/unit/sqlite-worker-lease.test.ts
npm run typecheck
```

Expected: new store tests and the independent Token lease tests pass.

- [ ] **Step 6: Review checkpoint**

```powershell
git diff --check -- src/providers/aliyun/sqlite-download-start-store.ts tests/unit/sqlite-download-start-store.test.ts
git status --short
```

Expected: no whitespace errors, no dependency changes, no changes to `lease.sqlite` implementation.

---

### Task 3: Prove cross-process and restart persistence

**Files:**
- Create: `tests/helpers/sqlite-download-start-child.mjs`
- Create: `tests/helpers/sqlite-download-start-inspect.mjs`
- Create: `tests/integration/sqlite-download-start-process.test.ts`

**Interfaces:**
- Consumes: the built `createSqliteWorkerDownloadStartStore` and `AliyunDownloadStartLimiter` exports.
- Produces: process-level proof that independent Node processes share the same committed sliding window.

- [ ] **Step 1: Write the child-process driver**

The helper must import module URLs supplied via environment variables, construct the real store with test-only `windowMs` and `guardMs`, call `limiter.acquire()`, and send sanitized IPC events only:

```js
send({ type: "started" });
await limiter.acquire(controller.signal);
send({ type: "granted", grantedAt: Date.now() });
```

Support one `cancel` IPC message. Never send database paths, SQL, row contents, or raw errors back to the parent.

- [ ] **Step 2: Write failing compiled-artifact process tests**

Compile `src` to a temporary directory as `sqlite-worker-lease-process.test.ts` already does. Resolve Node 22.23.1 through Volta only when the current Node lacks `node:sqlite`.

Use a 250 ms test window plus a 25 ms guard, then cover:

- two independent children grant within the first window;
- a third child does not grant before the first committed timestamp plus 275 ms;
- the third grants automatically afterward without a second parent invocation;
- two children exit, a newly started third process still waits on their persisted rows;
- two children racing for the last available slot produce only one grant before the boundary;
- cancelling a waiting child produces no extra row and does not disturb a later eligible child;
- only `download-rate-limit.sqlite` remains in its dedicated test lock directory after cleanup.

The inspector helper must open a caller-supplied database read-only and emit only this JSON shape, with rows ordered ascending:

```json
{"count":2,"startedAtMs":[1000,1001]}
```

It must not print the database path, SQL, errors, or any other table. Process tests must use the helper to confirm committed rows survive the original children exiting.

- [ ] **Step 3: Run process tests and verify RED**

```powershell
npx vitest run tests/integration/sqlite-download-start-process.test.ts
```

Expected: FAIL until the helper and real Worker store satisfy cross-process behavior.

- [ ] **Step 4: Complete only the minimal protocol fixes exposed by RED**

Keep fixes inside `sqlite-download-start-store.ts` and the new helper/test. Do not change window constants, Provider wiring, Tool behavior, or unrelated credential lease code in this task.

- [ ] **Step 5: Verify cross-process GREEN**

```powershell
npx vitest run tests/integration/sqlite-download-start-process.test.ts tests/integration/sqlite-worker-lease-process.test.ts
```

Expected: both SQLite implementations pass their independent process suites; the third download-start process waits and then completes automatically.

- [ ] **Step 6: Review checkpoint**

```powershell
git diff --check -- tests/helpers/sqlite-download-start-child.mjs tests/helpers/sqlite-download-start-inspect.mjs tests/integration/sqlite-download-start-process.test.ts src/providers/aliyun/sqlite-download-start-store.ts
git status --short
```

---

### Task 4: Wire the limiter immediately before `getDownloadUrl`

**Files:**
- Modify: `src/providers/aliyun/provider.ts`
- Modify: `src/runtime-composition.ts`
- Modify: `src/index.ts`
- Modify: `tests/unit/aliyun-read.test.ts`
- Modify: `tests/unit/aliyun-provider.test.ts`
- Modify: `tests/unit/aliyun-upload.test.ts`
- Modify: `tests/integration/admin-server.test.ts`
- Modify: `tests/integration/leakage.test.ts`
- Modify: `tests/integration/plugin-entry.test.ts`

**Interfaces:**
- Consumes: `Pick<AliyunDownloadStartLimiter, "acquire">` and `createSqliteWorkerDownloadStartStore`.
- Produces:

```ts
export type AliyunProviderOptions = {
  tokenService: AliyunTokenService;
  tokenManager: AliyunTokenRefresher;
  downloadStartLimiter: Pick<AliyunDownloadStartLimiter, "acquire">;
  baseUrl?: string;
  fetch?: AliyunFetch;
  clock?: () => number;
  delay?: AliyunDelay;
};
```

`createPanSyncRuntime` must construct exactly one store and one limiter at:

```ts
const downloadLimitDatabasePath = path.join(
  dataDir,
  "locks",
  "download-rate-limit.sqlite",
);
```

- [ ] **Step 1: Write failing Provider-order tests**

In `aliyun-read.test.ts`, inject a limiter whose `acquire` records `"permit"`. Record fetch starts as `"getDriveInfo"`, `"getDownloadUrl"`, and `"contentGET"`, then require:

```ts
expect(events).toEqual([
  "getDriveInfo",
  "permit",
  "getDownloadUrl",
  "contentGET",
]);
```

Also reject from `acquire` and assert `getDriveInfo` may already have occurred but neither `getDownloadUrl` nor the signed content URL was fetched. Require the public error to be `DOWNLOAD_FAILED`.

Extend the successful CDN request assertion with:

```ts
expect(new Headers(contentRequest.init?.headers).get("range")).toBeNull();
expect(contentRequests).toHaveLength(1);
```

- [ ] **Step 2: Write failing runtime-composition tests**

Add `downloadStartStoreFactory` injection to the plugin-entry test harness and capture its path. Assert:

```ts
expect(capturedDownloadDatabasePath).toBe(
  path.join(dataDir, "locks", "download-rate-limit.sqlite"),
);
expect(capturedDownloadDatabasePath).not.toBe(capturedLeaseDatabasePath);
expect(downloadStoreFactoryCalls).toBe(1);
```

The fake store returns `{ status: "granted" }`. Do not create or inspect any OpenClaw database.

- [ ] **Step 3: Run wiring tests and verify RED**

```powershell
npx vitest run tests/unit/aliyun-read.test.ts tests/integration/plugin-entry.test.ts
```

Expected: FAIL because Provider and runtime do not yet accept or construct the new limiter.

- [ ] **Step 4: Make the Provider dependency explicit**

Add a required `downloadStartLimiter` option and private field. In `openDownload`, immediately before the existing `this.#api.post("/adrive/v1.0/openFile/getDownloadUrl", ...)`, execute:

```ts
try {
  await this.#downloadStartLimiter.acquire(options.signal);
} catch {
  throw new PanSyncError("DOWNLOAD_FAILED");
}
```

Do not acquire the permit in `AliyunAuthorizedClient.post`, because that would count unrelated OpenAPI calls. Do not acquire after `getDownloadUrl`, because waiting could expire the signed URL.

- [ ] **Step 5: Compose the production store and limiter once**

In `runtime-composition.ts`:

```ts
const downloadStartStore = (
  options.downloadStartStoreFactory
  ?? createSqliteWorkerDownloadStartStore
)(downloadLimitDatabasePath);
const downloadStartLimiter = new AliyunDownloadStartLimiter({
  store: downloadStartStore,
});
const provider = new AliyunProvider({
  tokenService,
  tokenManager,
  downloadStartLimiter,
});
```

Add the factory type to `CreatePanSyncRuntimeOptions` and `PanSyncPluginEntryOptions`, forwarding it only for tests. Keep runtime configuration schema unchanged; users cannot tune the limit.

- [ ] **Step 6: Update every explicit Provider constructor**

Add this inert dependency to tests not exercising download starts:

```ts
downloadStartLimiter: { acquire: async () => undefined },
```

Update only the seven constructor sites listed under **Files**. Do not make the production Provider option optional and do not add a no-op production fallback.

- [ ] **Step 7: Verify Provider and runtime GREEN**

```powershell
npx vitest run tests/unit/aliyun-read.test.ts tests/unit/aliyun-provider.test.ts tests/unit/aliyun-upload.test.ts tests/integration/admin-server.test.ts tests/integration/leakage.test.ts tests/integration/plugin-entry.test.ts
npm run typecheck
```

Expected: all selected tests pass; rejected reservations produce no `getDownloadUrl` or content GET; existing upload and credential behavior is unchanged.

- [ ] **Step 8: Verify large-file confirmation consumes no permit**

Run the existing confirmation-focused orchestrator tests and retain their assertion that `provider.openDownload` is never called:

```powershell
npx vitest run tests/unit/read-orchestrator.test.ts -t "confirmation"
```

Because reservation occurs only inside `openDownload`, these results prove confirmation-only calls consume no SQLite start record.

- [ ] **Step 9: Review checkpoint**

```powershell
git diff --check -- src/providers/aliyun/provider.ts src/runtime-composition.ts src/index.ts tests
git status --short
```

---

### Task 5: Teach the AI and user that waiting is internal

**Files:**
- Modify: `src/read/tool.ts`
- Modify: `skills/pan-sync-upload/SKILL.md`
- Modify: `README.md`
- Modify: `tests/integration/tool.test.ts`
- Modify: `tests/integration/package.test.ts`

**Interfaces:**
- Produces: unchanged Tool input/output schemas and explicit no-duplicate-call operational guidance.

- [ ] **Step 1: Write failing Tool and package assertions**

Require the Tool description to match internal waiting and no duplicate call wording:

```ts
expect(downloadTool.description).toMatch(/wait internally|internal queue/iu);
expect(downloadTool.description).toMatch(/do not.*duplicate|do not.*retry/iu);
```

Require the packed Skill to state in both language sections that:

- the plugin shares a two-start/60-second window across sessions;
- a pending `pan_sync_download` waits internally and resumes automatically;
- the AI must not issue a duplicate or automatic retry while the Tool is pending;
- `DOWNLOAD_FAILED` is final for that call and must not trigger a tight retry loop.

Require the packed README to contain `2 次/60 秒`, `two starts per 60 seconds`, and an explanation that a third download can remain pending until the window opens.

- [ ] **Step 2: Verify documentation tests RED**

```powershell
npx vitest run tests/integration/tool.test.ts tests/integration/package.test.ts
```

Expected: the new waiting and sliding-window assertions fail against current wording.

- [ ] **Step 3: Update the Tool description minimally**

Use concise execution-adjacent copy without changing the schema:

```ts
description: "Download one concrete resource-drive file without overwriting an existing file. Omit localDirectory to use the workspace root; user-supplied workspace-relative missing directories are created. The call may wait internally for the shared Aliyun download window; do not duplicate or automatically retry a pending call.",
```

- [ ] **Step 4: Update `SKILL.md` operational rules**

Add semantically aligned Chinese and English instructions. Preserve existing list-before-download, large-file confirmation, one-at-a-time download, resource-drive, workspace path, leakage, and stable-error rules. Explicitly say that internal waiting is not `RATE_LIMITED`, does not require another Tool call, and must not cause the AI to start another session as a workaround.

- [ ] **Step 5: Update README user guidance**

Add one short paragraph to the Chinese download section and its matching English section. State that the threshold is a conservative compatibility rule based on community and observed behavior, not a published official guarantee. Explain that the third quick download can wait about 60 seconds and will continue automatically.

- [ ] **Step 6: Verify documentation GREEN**

```powershell
npx vitest run tests/integration/tool.test.ts tests/integration/package.test.ts tests/integration/leakage.test.ts
```

Expected: Tool contract, packed Skill, bilingual README, and leakage tests pass with no schema changes.

- [ ] **Step 7: Review checkpoint**

```powershell
git diff --check -- src/read/tool.ts skills/pan-sync-upload/SKILL.md README.md tests/integration/tool.test.ts tests/integration/package.test.ts
git status --short
```

---

### Task 6: Run full automated verification and materialize one exact package

**Files:**
- All planned source, test, Skill, README, design, and plan files.
- Generated artifact: one temporary `openclaw-plugin-sheen-pansync-0.1.7.tgz` outside the repository.

**Interfaces:**
- Consumes: Tasks 1-5.
- Produces: a single hashed `.tgz` reused unchanged for installed-package and live-account acceptance.

- [ ] **Step 1: Run focused regression**

```powershell
npx vitest run tests/unit/aliyun-download-start-limiter.test.ts tests/unit/sqlite-download-start-store.test.ts tests/unit/aliyun-read.test.ts tests/unit/aliyun-provider.test.ts tests/unit/aliyun-upload.test.ts tests/unit/read-orchestrator.test.ts tests/integration/sqlite-download-start-process.test.ts tests/integration/sqlite-worker-lease-process.test.ts tests/integration/plugin-entry.test.ts tests/integration/tool.test.ts tests/integration/package.test.ts tests/integration/leakage.test.ts
```

Expected: all selected tests pass; no unhandled promise, open handle, leaked Worker, or timer warnings.

- [ ] **Step 2: Run the complete repository gate**

```powershell
volta run --node 22.23.1 npm run verify
git diff --check
git status --short
```

Expected: typecheck, unit tests, integration tests, build, and package dry-run all exit 0. Status contains only planned changes plus the untouched user-owned `.gitignore`.

- [ ] **Step 3: Materialize and identify the exact artifact**

Use a task-specific temporary directory, clear inherited npm dry-run state, and pack exactly once:

```powershell
$acceptanceRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("sheen-pansync-window-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $acceptanceRoot | Out-Null
Remove-Item Env:npm_config_dry_run -ErrorAction SilentlyContinue
$packJson = volta run --node 22.23.1 npm pack --json --pack-destination $acceptanceRoot
$packReport = $packJson | ConvertFrom-Json
$tarball = Join-Path $acceptanceRoot $packReport[0].filename
Get-Item -LiteralPath $tarball | Select-Object Name,Length
Get-FileHash -Algorithm SHA256 -LiteralPath $tarball
```

Do not print archive contents that contain sensitive runtime state; the package tests already enforce the allowed boundary.

- [ ] **Step 4: Inspect the exact package boundary**

Require version `0.1.7`, the two new compiled limiter modules, the updated Skill and README, and no source maps outside the declared package boundary. Re-run the relevant package test against the same checkout before installation.

- [ ] **Step 5: Automated verification checkpoint**

Record sanitized counts, skip reasons, artifact filename, byte length, and SHA-256 in working notes. Do not create the final verification report until live acceptance finishes. Do not stage or commit files.

---

### Task 7: Install the exact artifact and run authorized live acceptance

**Files:**
- Create after completion: `docs/superpowers/verification/2026-08-05-aliyun-download-sliding-window-acceptance.md`
- Generated local download copies from acceptance; do not delete them unless separately authorized.

**Interfaces:**
- Consumes: the exact tarball and SHA-256 from Task 6, the current OpenClaw 2026.7.1-2 installation, and the configured real Aliyun/OpenList account.
- Produces: installed-package, Gateway, Tool-registration, strict-wait, and real-download evidence.

- [ ] **Step 1: Capture safe pre-install state**

Run read-only checks and retain sanitized fields only:

```powershell
openclaw --version
openclaw plugins inspect sheen-pansync --runtime --json
openclaw plugins doctor
openclaw gateway health
```

Confirm the currently installed version separately from the target `0.1.7`. Do not print credentials, configured URLs, dynamic ports, plugin state files, or raw Gateway logs.

- [ ] **Step 2: Install and load the exact tarball**

```powershell
openclaw plugins install $tarball --force
openclaw plugins enable sheen-pansync
openclaw gateway restart --safe
```

Do not alter unrelated plugin enablement or Tool policy. Keep legacy `pan-sync-helper` disabled.

- [ ] **Step 3: Verify the live runtime before cloud access**

```powershell
openclaw plugins list --json
openclaw plugins inspect sheen-pansync --runtime --json
openclaw plugins doctor
openclaw gateway health
```

Require installed version `0.1.7`, no plugin diagnostics, and runtime `toolNames` containing exactly the expected `pan_sync_upload`, `pan_sync_list`, and `pan_sync_download` registrations. A healthy Gateway alone is not acceptance.

- [ ] **Step 4: Select three safe remote files once**

Prefer previously established, sanitized file identities. If three reusable ordinary small files are not available, start one new Agent session and instruct exactly one bounded `pan_sync_list` call against the known resource-drive directory. Select three files below 100 MiB; do not traverse unrelated directories, download folders, or disclose names and IDs in the report.

Use a fresh opaque session identifier and a UTF-8 message file rather than embedding identifiers into shell history:

```powershell
openclaw agent --session-id $acceptanceSession --message-file $selectionPrompt --timeout 600 --json
```

- [ ] **Step 5: Execute the first two downloads and capture the committed window**

In the same session, instruct OpenClaw to call `pan_sync_download` strictly one at a time for the first two selected files, omit `localDirectory`, never retry, and report only stable statuses. Run:

```powershell
openclaw agent --session-id $acceptanceSession --message-file $firstTwoPrompt --timeout 600 --json
```

Require two Tool calls, two `downloaded` results, and zero failures. Immediately afterward, invoke the read-only inspector against the known plugin-owned `download-rate-limit.sqlite`. Store the sanitized JSON in memory and require `count` to be two. Do not print the database path:

```powershell
$previousDownloadStartDatabase = $env:PAN_SYNC_DOWNLOAD_START_DATABASE
try {
  $env:PAN_SYNC_DOWNLOAD_START_DATABASE = $downloadLimitDatabase
  $windowBeforeThird = volta run --node 22.23.1 node tests/helpers/sqlite-download-start-inspect.mjs | ConvertFrom-Json
  if ($windowBeforeThird.count -ne 2) { throw 'unexpected download window count' }
  $oldestStartMs = [int64]$windowBeforeThird.startedAtMs[0]
} finally {
  if ($null -eq $previousDownloadStartDatabase) {
    Remove-Item Env:PAN_SYNC_DOWNLOAD_START_DATABASE -ErrorAction SilentlyContinue
  } else {
    $env:PAN_SYNC_DOWNLOAD_START_DATABASE = $previousDownloadStartDatabase
  }
}
```

- [ ] **Step 6: Execute the third download as one pending Tool call**

Immediately issue a second turn in the same session containing exactly one `pan_sync_download` for the third file. The prompt must say that the Tool may wait internally, must not be duplicated, and must not be automatically retried:

```powershell
openclaw agent --session-id $acceptanceSession --message-file $thirdPrompt --timeout 900 --json
```

After it succeeds, run the same environment-variable wrapper for the read-only inspector, take the greatest committed timestamp as `$thirdStartMs`, and require:

```powershell
if (($thirdStartMs - $oldestStartMs) -lt 60250) {
  throw 'third download started before the protected window opened'
}
```

Also require exactly one Tool call in this turn, one `downloaded` result, no duplicate/retry, and three new regular workspace files with expected byte sizes across the complete journey. The inspector emits only counts and timestamps; never use raw signed URLs or raw Gateway logs as timing evidence.

- [ ] **Step 7: Stop on the first live failure**

If any Tool result is not `downloaded`, if a duplicate call occurs, or if timing cannot be proven, stop the live journey. Do not retry, do not add another remote probe, and do not relax the window. Continue only with read-only local diagnostics and report the acceptance as failed or blocked.

- [ ] **Step 8: Run final fresh evidence**

```powershell
openclaw gateway health
openclaw plugins inspect sheen-pansync --runtime --json
volta run --node 22.23.1 npm run verify
git diff --check
git status --short
```

Expected: Gateway healthy, target plugin/runtime loaded, full repository gate still green, and no unplanned tracked changes.

- [ ] **Step 9: Write the sanitized acceptance report**

Create `docs/superpowers/verification/2026-08-05-aliyun-download-sliding-window-acceptance.md` with:

- repository verification commands and pass/fail counts;
- exact tarball name, byte length, and SHA-256;
- installed version and runtime Tool-registration result;
- live Tool call count, success/failure count, whether the third call waited, and relative timing proof;
- confirmation that no retry, Range request, rate-limit pressure test, remote deletion, configuration change, push, publish, or PR occurred;
- confirmation that file names, remote/local paths, file IDs, drive IDs, account data, credentials, signed URLs, dynamic ports, and raw logs were excluded.

Do not claim release readiness if any automated, installed-package, runtime, or real-account gate fails.

- [ ] **Step 10: Final review checkpoint**

```powershell
git diff --check
git status --short
```

Report the untouched user-owned `.gitignore` separately from task changes. Leave all task files unstaged and uncommitted pending explicit user direction.
