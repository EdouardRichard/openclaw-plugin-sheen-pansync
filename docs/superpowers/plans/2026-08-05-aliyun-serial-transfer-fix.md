# Aliyun Serial Transfer Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serialize complete download and upload Tool lifecycles so no two downloads or two uploads from one Gateway access Aliyun concurrently.

**Architecture:** Keep independent FIFO gates for downloads and uploads, each with capacity one. Acquire the category gate before Token, metadata, directory, local-file, or remote access; release it in `finally` after success, confirmation, failure, cleanup, or cancellation. Preserve the shared 350 ms OpenAPI pacer and per-file sequential multipart PUT behavior.

**Tech Stack:** TypeScript 5.9, Node.js 24, Vitest, OpenClaw 2026.7.1-2.

## Global Constraints

- Download calls are FIFO serial across the complete lifecycle, including metadata and large-file confirmation.
- Upload calls are FIFO serial across the complete Tool lifecycle; one call may still contain up to 100 paths processed sequentially.
- Upload and download use independent gates and may overlap with each other.
- Queued cancellation sends no remote request and creates or opens no local file.
- Preserve stable error codes, resource-drive-only routing, default workspace-root downloads, collision-safe naming, 20 MiB sequential multipart uploads, 350 ms OpenAPI/PUT pacing, and no automatic retries.
- Preserve the current branch's OpenAPI pacing commit and do not modify the user-owned main-checkout `.gitignore`.
- Real acceptance performs one serial five-file download journey and one bounded two-call upload journey, with no retries or remote deletion.

---

### Task 1: Serialize the complete download lifecycle

**Files:**
- Modify: `src/read/download-concurrency.ts`
- Modify: `src/read/orchestrator.ts`
- Modify: `tests/unit/download-concurrency.test.ts`
- Modify: `tests/unit/read-orchestrator.test.ts`

**Interfaces:**
- Consumes: `FifoDownloadGate.acquire(signal?: AbortSignal): Promise<() => void>`.
- Produces: the same interface with default capacity one and `ReadOrchestrator.download()` acquiring it before Token or Provider access.

- [ ] **Step 1: Write failing complete-lifecycle download tests**

Change the gate default-capacity test to enqueue five callers and assert only the first receives a release function. In `read-orchestrator.test.ts`, start five downloads against a Provider whose metadata method records entry and whose stream completion is controllable. Before completing the first stream, assert:

```ts
expect(metadataCalls).toEqual(["file-1"]);
expect(maxActiveDownloads).toBe(1);
```

Complete each stream in order and assert only the next metadata call appears, ending with all five `status: "downloaded"` results.

- [ ] **Step 2: Verify RED**

```powershell
npx vitest run tests/unit/download-concurrency.test.ts tests/unit/read-orchestrator.test.ts
```

Expected: failure because the existing gate admits three callers and metadata lookup occurs before gate acquisition.

- [ ] **Step 3: Implement download lifecycle serialization**

Set `FifoDownloadGate` default capacity to one. Restructure `ReadOrchestrator.download()` so input ambiguity validation remains local, then acquire before resolving Provider, Token, or entry:

```ts
let releaseDownload: (() => void) | undefined;
try {
  releaseDownload = await this.#downloadGate.acquire(options.signal);
  return await this.#download(input, options);
} catch (error) {
  throw stableDownloadError(error);
} finally {
  releaseDownload?.();
}
```

Move the existing remote and stream work into private `#download`. Keep target cleanup around the file-writing section, but remove the later nested gate acquisition. Confirmation and metadata failures return or throw through the outer `finally`.

- [ ] **Step 4: Cover cancellation and release paths**

Assert a queued aborted download never calls `getValidAccessToken`, Provider metadata, or `openWorkspaceDownloadTarget`; then complete the active call and verify the next non-aborted waiter starts. Retain coverage for metadata failure, confirmation-required, short/long streams, write failure, and cleanup.

- [ ] **Step 5: Verify download GREEN**

```powershell
npx vitest run tests/unit/download-concurrency.test.ts tests/unit/read-orchestrator.test.ts tests/integration/tool.test.ts
```

Expected: all selected tests pass and maximum download lifecycle concurrency is one.

### Task 2: Serialize the complete upload Tool lifecycle

**Files:**
- Create: `src/upload/upload-concurrency.ts`
- Create: `tests/unit/upload-concurrency.test.ts`
- Modify: `src/upload/orchestrator.ts`
- Modify: `tests/unit/orchestrator.test.ts`

**Interfaces:**
- Produces: `FifoUploadGate.acquire(signal?: AbortSignal): Promise<() => void>` with default capacity one and `UPLOAD_FAILED` cancellation semantics.
- Consumes: the existing `UploadOrchestrator.upload(input, options)` public interface without schema changes.

- [ ] **Step 1: Write failing upload gate and orchestrator tests**

Create gate tests mirroring download FIFO behavior but expecting `UPLOAD_FAILED` on queued cancellation. In the orchestrator test, start two uploads with a controllable first `provider.uploadFile`; assert before releasing it:

```ts
expect(tokenCalls).toBe(1);
expect(ensureDirectoryCalls).toBe(1);
expect(uploadedInputs).toEqual(["first.bin"]);
```

After releasing the first upload, assert the second Token, directory, and upload operations begin, and both Tool results succeed in FIFO order.

- [ ] **Step 2: Verify upload RED**

```powershell
npx vitest run tests/unit/upload-concurrency.test.ts tests/unit/orchestrator.test.ts
```

Expected: the new gate is missing and existing concurrent Tool calls both reach Token/Provider operations.

- [ ] **Step 3: Implement `FifoUploadGate`**

Implement the same queue/release discipline as `FifoDownloadGate`, with default capacity one and `new PanSyncError("UPLOAD_FAILED")` for pre-aborted or queued-aborted callers. Release functions must be idempotent.

- [ ] **Step 4: Acquire upload gate before all upload work**

Add `readonly #uploadGate = new FifoUploadGate();`. Keep the local path-count validation before acquisition, then wrap the existing private upload operation:

```ts
let releaseUpload: (() => void) | undefined;
try {
  releaseUpload = await this.#uploadGate.acquire(options.signal);
  return await this.#upload(input, options);
} catch (error) {
  throw stableError(error);
} finally {
  releaseUpload?.();
}
```

This places Token acquisition, `ensureDirectory`, file opening, every file/part, and completion inside one Tool-call lease.

- [ ] **Step 5: Cover upload cancellation and release paths**

Assert an aborted queued upload performs no Token, path-guard, directory, or Provider operation. Verify the gate releases after success, partial file failure, global failure, and cancellation of the active upload.

- [ ] **Step 6: Verify upload GREEN**

```powershell
npx vitest run tests/unit/upload-concurrency.test.ts tests/unit/orchestrator.test.ts tests/unit/aliyun-upload.test.ts
```

Expected: all selected tests pass; single-call multi-file and multipart ordering remain unchanged.

### Task 3: Make the Skill issue only serial transfer calls

**Files:**
- Modify: `skills/pan-sync-upload/SKILL.md`
- Modify: `tests/integration/package.test.ts`

**Interfaces:**
- Produces: packaged instructions that use one-at-a-time downloads and one upload call with a combined `paths` array whenever possible.

- [ ] **Step 1: Write failing package assertions**

Require the packaged Skill to state, in Chinese and English:

- never issue concurrent `pan_sync_download` calls;
- wait for each download result before the next;
- combine multiple upload paths into one `pan_sync_upload` call when they share the destination;
- never issue concurrent `pan_sync_upload` calls;
- stop without immediate retry on stable failures.

Remove assertions that require 3+2 download batching.

- [ ] **Step 2: Verify Skill RED**

```powershell
npx vitest run tests/integration/package.test.ts -t "ships the guarded multi-file download Skill contract"
```

Expected: failure because the current Skill still instructs batches of three and lacks upload-call serialization.

- [ ] **Step 3: Update the Skill minimally**

Replace the 3+2 batching instruction with strict one-at-a-time download wording. Add upload wording that merges compatible paths into one Tool input and waits for an active upload call to finish before another. Do not alter authentication, resource-drive, path, confirmation, or error-code guidance.

- [ ] **Step 4: Verify packaged Skill GREEN**

```powershell
npx vitest run tests/integration/package.test.ts -t "ships the guarded multi-file download Skill contract"
```

Expected: the packed artifact contains the serial download and upload instructions.

### Task 4: Complete local gates and commit

**Files:**
- All Task 1-3 implementation and test files.

- [ ] **Step 1: Run focused transfer regression**

```powershell
npx vitest run tests/unit/download-concurrency.test.ts tests/unit/read-orchestrator.test.ts tests/unit/upload-concurrency.test.ts tests/unit/orchestrator.test.ts tests/unit/aliyun-rate-limiter.test.ts tests/unit/aliyun-upload.test.ts tests/integration/tool.test.ts tests/integration/package.test.ts
```

- [ ] **Step 2: Run the full repository gate**

```powershell
npm run verify
git diff --check
git status --short
```

Expected: typecheck, unit, integration, build, and package checks pass; only planned files are modified and the isolated worktree is otherwise clean.

- [ ] **Step 3: Commit locally**

```powershell
git add -- src/read/download-concurrency.ts src/read/orchestrator.ts src/upload/upload-concurrency.ts skills/pan-sync-upload/SKILL.md tests/unit/download-concurrency.test.ts tests/unit/read-orchestrator.test.ts tests/unit/upload-concurrency.test.ts tests/unit/orchestrator.test.ts tests/integration/package.test.ts
git commit -m "fix: serialize Aliyun transfer lifecycles"
```

### Task 5: Install exact artifact and run bounded real acceptance

**Files:**
- Generated temporary package and non-sensitive acceptance fixtures only; no tracked source changes.

- [ ] **Step 1: Pack, hash, install, and restart**

Materialize one exact tarball from the committed branch, record name/bytes/SHA-256, install it with `openclaw plugins install "npm-pack:$tarball" --force`, enable `sheen-pansync`, and run `openclaw gateway restart --safe`.

- [ ] **Step 2: Verify runtime before cloud access**

Run plugin runtime inspection, plugin doctor, Gateway health, and `/tools` in a new session. Require version `0.1.6`, no diagnostics, and all three `pan_sync_*` Tools.

- [ ] **Step 3: Run one serial five-file download acceptance**

Reuse the established session's five known files without another list call. Instruct five strictly sequential `pan_sync_download` calls, omit `localDirectory`, never retry, and report only counts and stable statuses. Expected: five `downloaded`, zero failures, and five new workspace-root files.

- [ ] **Step 4: Prepare bounded upload fixtures**

Create one deterministic file of exactly 42,991,616 bytes and one small deterministic text file in a dedicated local acceptance directory. Record only byte sizes and hashes; never print their local names in the final report.

- [ ] **Step 5: Run one two-call serial upload acceptance**

In a new Agent session, ask OpenClaw to issue two `pan_sync_upload` calls in the same turn toward one unique dedicated remote acceptance directory. The calls may be proposed together, but the plugin gate must serialize actual Token, directory, and upload work. Do not retry. Expected: both return `uploaded`; the large file uses three sequential parts under the installed implementation.

- [ ] **Step 6: Verify remote upload once**

Call `pan_sync_list` exactly once for the dedicated acceptance directory and verify two files exist with remote byte sizes matching 42,991,616 and the small fixture size. Do not print names or IDs and do not delete remote files.

- [ ] **Step 7: Final evidence**

Run fresh Gateway health, plugin runtime inspection, `npm run verify`, `git status --short`, and `git log -4 --oneline`. Report any live failure honestly and stop without another real attempt.
