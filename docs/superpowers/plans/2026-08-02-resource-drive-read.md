# Resource Drive Read Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every Aliyun file operation target the resource drive, add paginated listing/search and safe workspace download tools, and ship a screenshot-backed bilingual quick-start README.

**Architecture:** Keep `UploadOrchestrator` focused on uploads, add an Aliyun read adapter plus a separate `ReadOrchestrator`, and isolate local download-path handling in a workspace module. `pan_sync_list` performs bounded directory listing or resumable breadth-first name search; `pan_sync_download` resolves one file, enforces per-call large-file confirmation, streams it into an exclusive workspace file, and returns only a relative path.

**Tech Stack:** Node.js `>=22.22.3`, TypeScript ESM, OpenClaw Plugin SDK `>=2026.7.1-2`, TypeBox, native `fetch` and `node:fs`, Vitest, npm package verification.

## Global Constraints

- File operations use only non-empty `resource_drive_id`; never fall back to `default_drive_id` or `backup_drive_id`.
- `pan_sync_list` defaults to `/`, returns 20 entries by default, accepts 1 through 100, and processes at most 20 Aliyun list pages per call.
- Search is a resumable breadth-first traversal over `openFile/list`; cursor input is capped at 65,536 UTF-8 bytes and may retain at most 512 pending directories.
- `pan_sync_download` handles one ordinary file per call and never recursively downloads a folder.
- Downloads default to the current workspace root, use `name (1).ext` collision naming, and never overwrite an existing file.
- The large-file confirmation threshold is exactly `100 * 1024 * 1024` bytes; confirmation is a boolean for one tool call and is never persisted.
- Download bodies stream to disk; the plugin never returns file contents, Access Tokens, download URLs, remote raw responses, or local absolute paths.
- Existing OpenList credential storage, refresh behavior, upload sequencing, and `/openClawShare` upload-directory default remain unchanged.
- Preserve `skills/pan-sync-upload/SKILL.md` as the published skill path while expanding its upload/list/download guidance in Chinese and English.
- README screenshots must come from the actual test flow and must exclude tokens, URL fragments, dynamic ports, real identities, file IDs, absolute paths, hostnames, usernames, and raw Shell or service logs.
- Do not stage or commit existing unrelated untracked files under `dist/`, `node_modules/`, or other `docs/superpowers` paths.
- Every production behavior follows `superpowers:test-driven-development`; completion claims follow `superpowers:verification-before-completion`.

---

## File Structure

**Create:**

- `src/providers/aliyun/resource-drive.ts` — parse and require the resource-drive account field.
- `src/providers/aliyun/read.ts` — parse Aliyun entries and open download response streams without exposing signed URLs.
- `src/read/cursor.ts` — versioned, bounded search cursor codec.
- `src/read/orchestrator.ts` — listing, breadth-first search, large-file confirmation, and download orchestration.
- `src/read/tool.ts` — `pan_sync_list` and `pan_sync_download` schemas, safe projections, and registration.
- `src/workspace/download-target.ts` — workspace-contained destination resolution and exclusive collision naming.
- `tests/unit/aliyun-read.test.ts` — provider read and download transport contract.
- `tests/unit/read-cursor.test.ts` — cursor validation and round-trip behavior.
- `tests/unit/read-orchestrator.test.ts` — listing/search/download orchestration behavior.
- `tests/unit/download-target.test.ts` — local path safety, concurrency, and cleanup.
- `docs/images/readme/01-plugin-ready.png` — real sanitized installed-plugin/status screenshot.
- `docs/images/readme/02-upload-resource-drive.png` — real sanitized upload screenshot.
- `docs/images/readme/03-search-resource-drive.png` — real sanitized list/search screenshot.
- `docs/images/readme/04-download-and-read.png` — real sanitized download/read screenshot.
- `docs/superpowers/verification/2026-08-02-resource-drive-read.md` — automated, OpenClaw, Aliyun, screenshot, and packaging evidence.

**Modify:**

- `src/contracts.ts` — list/download DTOs and Provider read interfaces.
- `src/errors.ts` — read/download stable error codes and operation-specific safe fallback.
- `src/providers/aliyun/provider.ts` — resource-drive selection and read-method delegation.
- `src/runtime-composition.ts` — construct and expose `ReadOrchestrator`.
- `src/index.ts` — register both read tools and update plugin description.
- `openclaw.plugin.json` — declare all three tools and the expanded capability.
- `skills/pan-sync-upload/SKILL.md` — bilingual upload/list/download intent and safety rules.
- `README.md` — complete Chinese and English quick starts with real screenshots.
- `package.json` — publish `docs/images/readme`.
- `tests/unit/aliyun-provider.test.ts` — resource-drive selection regression.
- `tests/unit/aliyun-upload.test.ts` — upload requests use resource drive.
- `tests/integration/tool.test.ts` — tool schemas, redaction, skill, and installed registry.
- `tests/integration/plugin-entry.test.ts` — three-tool composition registration.
- `tests/integration/package.test.ts` — bilingual README and image package contract.
- `tests/integration/leakage.test.ts` — read/download canary coverage.

---

### Task 1: Make the resource drive the only Aliyun file target

**Files:**

- Create: `src/providers/aliyun/resource-drive.ts`
- Modify: `src/providers/aliyun/provider.ts`
- Modify: `src/errors.ts`
- Test: `tests/unit/aliyun-provider.test.ts`
- Test: `tests/unit/aliyun-upload.test.ts`

**Interfaces:**

- Produces: `parseResourceDriveSummary(body: unknown): { driveId: string; userId: string; displayName?: string }`.
- Produces: `PanSyncErrorCode` member `RESOURCE_DRIVE_UNAVAILABLE`.
- Preserves: `AliyunProvider.ensureDirectory(...)` and `uploadFile(...)` public signatures.

- [ ] **Step 1: Write the failing resource-drive selection tests**

Add a test whose drive response deliberately makes `default_drive_id` the backup target:

```ts
it("uses resource_drive_id when default_drive_id points at backup storage", async () => {
  const server = await fakeServer([
    driveInfo({
      default_drive_id: "drive-backup-default",
      resource_drive_id: "drive-resource",
      backup_drive_id: "drive-backup",
    }),
  ]);

  await expect(provider(server).ensureDirectory("/", "access-old"))
    .resolves.toMatchObject({
      id: "root",
      providerState: { driveId: "drive-resource" },
    });
});
```

Add a missing-resource regression:

```ts
it("rejects an account without a resource drive instead of falling back", async () => {
  const server = await fakeServer([
    driveInfo({ resource_drive_id: undefined }),
  ]);

  const error = await rejectedPanSyncError(() =>
    provider(server).ensureDirectory("/", "access-old"));

  expect(error.code).toBe("RESOURCE_DRIVE_UNAVAILABLE");
  expect(server.requests).toHaveLength(1);
});
```

In `aliyun-upload.test.ts`, change one create/complete regression fixture so it returns all three IDs and assert every `drive_id` is `drive-resource`.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```powershell
npm test -- --run tests/unit/aliyun-provider.test.ts tests/unit/aliyun-upload.test.ts
```

Expected: FAIL because current parsing selects `default_drive_id` and accepts backup/default fallback.

- [ ] **Step 3: Add the stable resource-drive error and parser**

Add to `PanSyncErrorCode`:

```ts
| "RESOURCE_DRIVE_UNAVAILABLE"
```

Implement the focused parser in `resource-drive.ts`:

```ts
export type ResourceDriveSummary = {
  driveId: string;
  userId: string;
  displayName?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function nonEmptyString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function parseResourceDriveSummary(body: unknown): ResourceDriveSummary {
  if (!isRecord(body)) throw new PanSyncError("CREDENTIALS_INVALID");
  const driveId = nonEmptyString(body, "resource_drive_id");
  const userId = nonEmptyString(body, "user_id");
  if (driveId === undefined) {
    throw new PanSyncError("RESOURCE_DRIVE_UNAVAILABLE");
  }
  if (userId === undefined) throw new PanSyncError("CREDENTIALS_INVALID");
  const displayName = nonEmptyString(body, "name")
    ?? nonEmptyString(body, "nick_name")
    ?? nonEmptyString(body, "user_name");
  return displayName === undefined
    ? { driveId, userId }
    : { driveId, userId, displayName };
}
```

Delete the old local `parseDriveSummary` from `provider.ts` and use `parseResourceDriveSummary` in credential validation and directory creation.

- [ ] **Step 4: Update existing test expectations to the approved target**

Replace existing assertions and fake request bodies that expect `drive-default` with `drive-resource` only where the account fixture supplies `resource_drive_id`. Do not remove `default_drive_id` or `backup_drive_id` from the fixtures; keeping them proves the selection order cannot regress.

- [ ] **Step 5: Run the focused tests and verify GREEN**

Run:

```powershell
npm test -- --run tests/unit/aliyun-provider.test.ts tests/unit/aliyun-upload.test.ts
```

Expected: PASS, with all create/list/complete request bodies using `drive-resource`.

- [ ] **Step 6: Commit the resource-drive correction**

```powershell
git add src/providers/aliyun/resource-drive.ts src/providers/aliyun/provider.ts src/errors.ts tests/unit/aliyun-provider.test.ts tests/unit/aliyun-upload.test.ts
git commit -m "fix: target aliyun resource drive"
```

---

### Task 2: Add Aliyun remote-entry and download-stream primitives

**Files:**

- Create: `src/providers/aliyun/read.ts`
- Create: `tests/unit/aliyun-read.test.ts`
- Modify: `src/contracts.ts`
- Modify: `src/providers/aliyun/provider.ts`
- Modify: `src/providers/aliyun/upload.ts`

**Interfaces:**

- Produces: `RemoteEntry`, `RemoteEntryPage`, `ProviderListInput`, `ProviderDownloadInput`, and `ProviderDownload` in `src/contracts.ts`.
- Produces provider methods:

```ts
getReadRoot(accessToken: string, options?: ProviderOperationOptions): Promise<RemoteDirectory>;
resolveEntry(remotePath: string, accessToken: string, options?: ProviderOperationOptions): Promise<RemoteEntry>;
getEntryById(fileId: string, accessToken: string, options?: ProviderOperationOptions): Promise<RemoteEntry>;
listEntries(input: ProviderListInput, options?: ProviderOperationOptions): Promise<RemoteEntryPage>;
openDownload(input: ProviderDownloadInput, options?: ProviderOperationOptions): Promise<ProviderDownload>;
```

- Consumes: `parseResourceDriveSummary` from Task 1 and `AliyunAuthorizedClient` token-retry behavior.

- [ ] **Step 1: Define failing provider read tests**

Create `tests/unit/aliyun-read.test.ts` with these observable cases:

```ts
it("lists resource-drive entries with a next marker", async () => {
  const root = await provider.getReadRoot("access-old");
  const page = await provider.listEntries({
    accessToken: "access-old",
    directory: root,
    limit: 20,
  });
  expect(page.entries).toEqual([
    expect.objectContaining({
      id: "file-report",
      parentId: "root",
      name: "report.pdf",
      type: "file",
      size: 42,
      remotePath: "/report.pdf",
    }),
  ]);
  expect(page.nextMarker).toBe("page-2");
  expect(listRequest.body).toMatchObject({ drive_id: "drive-resource" });
});

it("resolves an exact resource-drive path", async () => {
  await expect(provider.resolveEntry("/reports/report.pdf", "access-old"))
    .resolves.toMatchObject({ id: "file-report", type: "file" });
  expect(request.path).toBe("/adrive/v1.0/openFile/get_by_path");
});

it("gets resource-drive file metadata by ID", async () => {
  await expect(provider.getEntryById("file-report", "access-old"))
    .resolves.toMatchObject({ id: "file-report", type: "file", size: 42 });
  expect(request.path).toBe("/adrive/v1.0/openFile/get");
});
```

Use an injected `fetch` for the download test. Return JSON for `getDriveInfo` and `getDownloadUrl`, then return `new Response(Uint8Array.from([1, 2, 3]))` for the signed URL. Assert the signed-URL request has no `authorization` header and the returned object exposes a stream, not the URL.

- [ ] **Step 2: Run the new tests and verify RED**

Run:

```powershell
npm test -- --run tests/unit/aliyun-read.test.ts
```

Expected: FAIL because the contracts and provider methods do not exist.

- [ ] **Step 3: Add exact read contracts**

Add these shapes to `src/contracts.ts`:

```ts
export type RemoteEntry = {
  id: string;
  parentId: string;
  name: string;
  type: "file" | "folder";
  size?: number;
  updatedAt?: string;
  remotePath?: string;
  providerState: Readonly<Record<string, unknown>>;
};

export type RemoteEntryPage = {
  entries: RemoteEntry[];
  nextMarker?: string;
};

export type ProviderListInput = {
  accessToken: string;
  directory: RemoteDirectory;
  marker?: string;
  limit: number;
};

export type ProviderDownloadInput = {
  accessToken: string;
  entry: RemoteEntry;
};

export type ProviderDownload = {
  stream: ReadableStream<Uint8Array>;
  size: number;
};
```

Extend `CloudDriveProvider` with the five methods from the Interfaces block.

- [ ] **Step 4: Implement strict Aliyun response parsing**

In `src/providers/aliyun/read.ts`, add parsers that reject malformed types, unsafe names, negative or unsafe sizes, missing IDs, and non-array list bodies. Build each child `remotePath` from the already-normalized parent path plus exactly one entry name.

Use these endpoints and request bodies:

```ts
POST /adrive/v1.0/openFile/list
{ drive_id, parent_file_id, limit, marker? }

POST /adrive/v1.0/openFile/get_by_path
{ drive_id, file_path }

POST /adrive/v1.0/openFile/get
{ drive_id, file_id }

POST /adrive/v1.0/openFile/getDownloadUrl
{ drive_id, file_id }
```

Map list/path shape failures to `REMOTE_DIRECTORY_FAILED`, missing exact paths to `REMOTE_FILE_NOT_FOUND`, and download-address/stream failures to `DOWNLOAD_FAILED`.

- [ ] **Step 5: Implement provider delegation and no-auth CDN fetch**

Add a small `resourceDriveContext(accessToken, options)` helper in `provider.ts` that calls `getDriveInfo`, parses `resource_drive_id`, and returns the possibly refreshed token plus root `RemoteDirectory`.

Implement `openDownload` so the OpenAPI POST uses `AliyunAuthorizedClient.post`, but the signed URL is fetched with:

```ts
const response = await client.fetch(downloadUrl, {
  method: "GET",
  ...(options.signal === undefined ? {} : { signal: options.signal }),
});
```

Do not add `authorization`, `referer`, or provider response bodies to errors. Require `response.ok`, non-null `response.body`, and a finite non-negative entry size.

- [ ] **Step 6: Run provider read and upload regressions**

Run:

```powershell
npm test -- --run tests/unit/aliyun-read.test.ts tests/unit/aliyun-provider.test.ts tests/unit/aliyun-upload.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit the provider read layer**

```powershell
git add src/contracts.ts src/providers/aliyun/provider.ts src/providers/aliyun/read.ts src/providers/aliyun/upload.ts tests/unit/aliyun-read.test.ts
git commit -m "feat: add aliyun read primitives"
```

---

### Task 3: Implement bounded listing and resumable resource-drive search

**Files:**

- Create: `src/read/cursor.ts`
- Create: `src/read/orchestrator.ts`
- Create: `tests/unit/read-cursor.test.ts`
- Create: `tests/unit/read-orchestrator.test.ts`
- Modify: `src/contracts.ts`

**Interfaces:**

- Produces: `ReadOrchestrator.list(input: PanSyncListInput, options?: ProviderOperationOptions): Promise<PanSyncListResult>`.
- Produces: `encodeSearchCursor(state: SearchCursorState): string` and `decodeSearchCursor(input: string, identity: SearchIdentity): SearchCursorState`.
- Consumes: `ProviderRegistry.resolve`, `TokenManager.getValidAccessToken`, and the Provider read methods from Task 2.

- [ ] **Step 1: Add list DTOs and failing direct-list tests**

Add to `src/contracts.ts`:

```ts
export type PanSyncListInput = {
  provider?: ProviderId;
  remoteDirectory?: string;
  query?: string;
  limit?: number;
  cursor?: string;
};

export type PanSyncListResult = {
  provider: ProviderId;
  remoteDirectory: string;
  query?: string;
  entries: Array<{
    fileId: string;
    name: string;
    type: "file" | "folder";
    size?: number;
    updatedAt?: string;
    remotePath?: string;
  }>;
  nextCursor?: string;
};
```

In `read-orchestrator.test.ts`, make a fake Provider and assert that no-query input defaults to `/` and `limit: 20`, calls one logical directory page, and projects no `providerState`.

- [ ] **Step 2: Add failing cursor tests**

Cover round-trip state and every rejection:

```ts
expect(() => decodeSearchCursor("not-base64", identity)).toThrowError(PanSyncError);
expect(() => decodeSearchCursor(validCursor, changedQuery)).toThrowError(PanSyncError);
expect(() => decodeSearchCursor("a".repeat(65_537), identity)).toThrowError(PanSyncError);
```

Also reject unknown versions, more than 512 pending directories, more than 100 buffered matches, control characters, missing IDs, and a cursor whose provider, root directory, query, or limit differs from the current call.

- [ ] **Step 3: Run cursor and list tests and verify RED**

Run:

```powershell
npm test -- --run tests/unit/read-cursor.test.ts tests/unit/read-orchestrator.test.ts
```

Expected: FAIL because the cursor codec and orchestrator are absent.

- [ ] **Step 4: Implement the cursor codec**

Use versioned base64url JSON with this internal state:

```ts
export type SearchIdentity = {
  provider: ProviderId;
  remoteDirectory: string;
  query: string;
  limit: number;
};

export type SearchCursorState = {
  v: 1;
  identity: SearchIdentity;
  pending: Array<{
    id: string;
    path: string;
    marker?: string;
  }>;
  buffered: Array<{
    fileId: string;
    name: string;
    type: "file" | "folder";
    size?: number;
    updatedAt?: string;
    remotePath?: string;
  }>;
};
```

The decoder must validate decoded byte length before `JSON.parse`, validate every field after parsing, and return a new projected object rather than the parsed record. Map all invalid cursor inputs to `REMOTE_DIRECTORY_FAILED` without echoing the cursor.

- [ ] **Step 5: Implement direct directory listing**

`ReadOrchestrator.list` must normalize the remote directory, validate `limit` in `1..100`, obtain the Provider and Access Token, resolve the exact starting directory, and call `listEntries` once. Use the Provider marker as the direct-list cursor state so a later call continues the same directory.

Projection must be explicit:

```ts
return {
  provider: provider.id,
  remoteDirectory,
  ...(query === undefined ? {} : { query }),
  entries: page.entries.map(projectRemoteEntry),
  ...(nextCursor === undefined ? {} : { nextCursor }),
};
```

- [ ] **Step 6: Add failing breadth-first search tests**

Build a tree where the first page contains folders and a non-match, a child page contains a Chinese-name match, and another child contains an English case-insensitive match. Assert:

- breadth-first order;
- Unicode-safe name containment;
- no more than 20 `listEntries` calls;
- result count stops at the requested limit;
- `nextCursor` resumes without repeating prior results;
- more than 512 pending folders maps to `REMOTE_DIRECTORY_FAILED` without leaking IDs.

- [ ] **Step 7: Implement bounded search**

Normalize match keys with:

```ts
function matchKey(value: string): string {
  return value.normalize("NFC").toLocaleLowerCase("en-US");
}
```

Use a FIFO `pending` queue. Each entry holds one folder ID/path and its current marker. Process no more than 20 Provider pages in one call. Enqueue discovered folders and process every entry in each fetched page. Return at most `limit` matches and store additional matches from an already-fetched page in the cursor's bounded `buffered` list; drain `buffered` before the next Provider request. Encode remaining work in `nextCursor`; never put `providerState`, drive IDs, tokens, or local paths into it.

- [ ] **Step 8: Run focused tests and verify GREEN**

Run:

```powershell
npm test -- --run tests/unit/read-cursor.test.ts tests/unit/read-orchestrator.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit listing and search**

```powershell
git add src/contracts.ts src/read/cursor.ts src/read/orchestrator.ts tests/unit/read-cursor.test.ts tests/unit/read-orchestrator.test.ts
git commit -m "feat: list and search resource drive"
```

---

### Task 4: Stream downloads into exclusive workspace files

**Files:**

- Create: `src/workspace/download-target.ts`
- Create: `tests/unit/download-target.test.ts`
- Modify: `src/read/orchestrator.ts`
- Modify: `tests/unit/read-orchestrator.test.ts`
- Modify: `src/contracts.ts`
- Modify: `src/errors.ts`

**Interfaces:**

- Produces: `ReadOrchestrator.download(input: DownloadRequest, options?: ProviderOperationOptions): Promise<PanSyncDownloadResult>` where `DownloadRequest = PanSyncDownloadInput & { workspaceDir: string }`.
- Produces: `openWorkspaceDownloadTarget(workspaceDir, localDirectory, remoteName): Promise<WorkspaceDownloadTarget>`.
- Consumes: `CloudDriveProvider.resolveEntry`, `getEntryById`, and `openDownload` from Task 2.

- [ ] **Step 1: Add failing destination-safety tests**

Test an existing real workspace directory and assert:

```ts
const first = await openWorkspaceDownloadTarget(root, undefined, "report.pdf");
await first.handle.close();
const second = await openWorkspaceDownloadTarget(root, undefined, "report.pdf");
expect(second.relativePath).toBe("report (1).pdf");
```

Add cases for concurrent calls, nested existing directories, `../outside`, absolute outside paths, symlink escape, control characters, slash/backslash in the remote name, and cleanup that removes only the file created by that target.

- [ ] **Step 2: Run destination tests and verify RED**

Run:

```powershell
npm test -- --run tests/unit/download-target.test.ts
```

Expected: FAIL because `download-target.ts` does not exist.

- [ ] **Step 3: Implement exclusive workspace target creation**

Resolve the lexical and canonical workspace root, require the optional target directory to already exist inside that root, reject symlink escape, and reduce the remote name to one safe basename. Split names with `path.parse` so collision candidates are:

```ts
report.pdf
report (1).pdf
report (2).pdf
```

Use `open(candidate, "wx", 0o600)` in the naming loop. Retry only `EEXIST`; map access and path failures to `WORKSPACE_PATH_REJECTED`. Return:

```ts
export type WorkspaceDownloadTarget = {
  handle: FileHandle;
  relativePath: string;
  cleanup(): Promise<void>;
};
```

`cleanup()` must close the handle if needed and unlink only the exact created file.

- [ ] **Step 4: Add failing download orchestration tests**

Add `PanSyncDownloadInput` and a result union:

```ts
export type PanSyncDownloadInput = {
  provider?: ProviderId;
  fileId?: string;
  remotePath?: string;
  localDirectory?: string;
  confirmedLargeDownload?: boolean;
};

export type PanSyncDownloadResult =
  | {
      provider: ProviderId;
      remoteName: string;
      localPath: string;
      size: number;
      status: "downloaded";
    }
  | {
      provider: ProviderId;
      remoteName: string;
      fileId: string;
      size: number;
      status: "confirmation_required";
      code: "DOWNLOAD_CONFIRMATION_REQUIRED";
    };
```

Test exactly `104_857_600` bytes as allowed and `104_857_601` bytes as confirmation-required. Assert the latter never calls `openDownload` or creates a local file. Add confirmed-large, ordinary file, directory rejection, missing file, cancellation, short stream, long stream, provider failure, and local write failure cases.

- [ ] **Step 5: Run download orchestration tests and verify RED**

Run:

```powershell
npm test -- --run tests/unit/read-orchestrator.test.ts tests/unit/download-target.test.ts
```

Expected: FAIL because `download` is absent.

- [ ] **Step 6: Implement metadata gating and stream writing**

Require exactly one of `fileId` and `remotePath`. Resolve paths with `provider.resolveEntry(remotePath, accessToken, options)` and IDs with `provider.getEntryById(fileId, accessToken, options)`.

Before opening a local file:

```ts
if (entry.type !== "file") throw new PanSyncError("REMOTE_ENTRY_NOT_FILE");
if (entry.size === undefined) throw new PanSyncError("DOWNLOAD_FAILED");
if (entry.size > 100 * 1024 * 1024 && !input.confirmedLargeDownload) {
  return {
    provider: provider.id,
    remoteName: entry.name,
    fileId: entry.id,
    size: entry.size,
    status: "confirmation_required",
    code: "DOWNLOAD_CONFIRMATION_REQUIRED",
  };
}
```

After opening the exclusive target, iterate the Web stream, check `AbortSignal` before each write, count bytes, and reject as soon as bytes exceed metadata size. On success require exact equality, close the handle, and return the relative path. In `catch` or abort, call `target.cleanup()` and map unknown errors to `DOWNLOAD_FAILED`.

- [ ] **Step 7: Add the read/download error codes and safe fallback support**

Add:

```ts
| "REMOTE_FILE_NOT_FOUND"
| "REMOTE_FILE_AMBIGUOUS"
| "REMOTE_ENTRY_NOT_FILE"
| "DOWNLOAD_CONFIRMATION_REQUIRED"
| "DOWNLOAD_FAILED"
```

Change `safeErrorDetails` to accept an explicit fallback while keeping upload callers unchanged:

```ts
export function safeErrorDetails(
  error: unknown,
  fallback: PanSyncErrorCode = "UPLOAD_FAILED",
): { code: PanSyncErrorCode };
```

- [ ] **Step 8: Run all read unit tests and verify GREEN**

Run:

```powershell
npm test -- --run tests/unit/aliyun-read.test.ts tests/unit/read-cursor.test.ts tests/unit/read-orchestrator.test.ts tests/unit/download-target.test.ts
```

Expected: PASS with no leaked absolute path or signed URL in output.

- [ ] **Step 9: Commit secure download support**

```powershell
git add src/contracts.ts src/errors.ts src/read/orchestrator.ts src/workspace/download-target.ts tests/unit/read-orchestrator.test.ts tests/unit/download-target.test.ts
git commit -m "feat: download resource files safely"
```

---

### Task 5: Register safe list and download Tools

**Files:**

- Create: `src/read/tool.ts`
- Modify: `src/runtime-composition.ts`
- Modify: `src/index.ts`
- Modify: `openclaw.plugin.json`
- Modify: `tests/integration/tool.test.ts`
- Modify: `tests/integration/plugin-entry.test.ts`
- Modify: `tests/integration/leakage.test.ts`

**Interfaces:**

- Produces: `registerPanSyncReadTools(api, orchestrator)` registering exactly `pan_sync_list` and `pan_sync_download`.
- Consumes: `ReadOrchestrator.list` and `ReadOrchestrator.download` from Tasks 3 and 4.
- Updates: `PanSyncRuntime.readOrchestrator`.

- [ ] **Step 1: Write failing exact-schema tests**

Assert `pan_sync_list` has only these properties:

```ts
{
  provider?: "aliyun";
  remoteDirectory?: string;
  query?: string;
  limit?: number; // integer, min 1, max 100
  cursor?: string; // min 1, max 65536
}
```

Assert `pan_sync_download` has only these properties:

```ts
{
  provider?: "aliyun";
  fileId?: string;
  remotePath?: string;
  localDirectory?: string;
  confirmedLargeDownload?: boolean;
}
```

Use a TypeBox union or a runtime guard so exactly one of `fileId` and `remotePath` is accepted. Assert forged `workspaceDir`, signed URL, access token, and unknown properties fail schema validation.

- [ ] **Step 2: Write failing safe-projection and workspace-authority tests**

Use orchestrator fakes that append canary fields to their runtime values. Assert list output contains only the approved DTO fields and download output contains only relative `localPath`. When the Tool factory receives no `workspaceDir`, `pan_sync_download` returns `WORKSPACE_PATH_REJECTED` without calling the orchestrator; `pan_sync_list` remains available because it does not write locally.

- [ ] **Step 3: Update registration tests before production code**

Change plugin-entry expectations to:

```ts
expect(registrations.tools).toEqual(expect.arrayContaining([
  "pan_sync_upload",
  "pan_sync_list",
  "pan_sync_download",
]));
```

Update the installed manifest probe so its fixture registers all three declared tools and assert OpenClaw reports all three without `contracts.tools` diagnostics.

- [ ] **Step 4: Run focused integration tests and verify RED**

Run:

```powershell
npm test -- --run tests/integration/tool.test.ts tests/integration/plugin-entry.test.ts tests/integration/leakage.test.ts
```

Expected: FAIL because read Tool registration and runtime composition are absent.

- [ ] **Step 5: Implement read Tool schemas and explicit projections**

In `src/read/tool.ts`, use TypeBox schemas with `additionalProperties: false`. Keep separate factory functions so each Tool has one description and one fallback error code:

```ts
await orchestrator.list(input, options)      // fallback REMOTE_DIRECTORY_FAILED
await orchestrator.download(input, options)  // fallback DOWNLOAD_FAILED
```

Construct JSON results from approved fields rather than serializing Provider or orchestrator objects. Never echo invalid raw inputs in error results.

- [ ] **Step 6: Compose and register the read runtime**

Construct one `ReadOrchestrator` beside `UploadOrchestrator` in `createPanSyncRuntime`, sharing the same Provider Registry and Token Manager. Register both read tools in `src/index.ts`.

Update `openclaw.plugin.json`:

```json
"contracts": {
  "tools": ["pan_sync_upload", "pan_sync_list", "pan_sync_download"]
}
```

Update the manifest and plugin descriptions to mention upload and read access without promising folder download.

- [ ] **Step 7: Extend leakage coverage**

Exercise list and download with canaries for Access Token, signed URL, drive ID, local absolute path, and remote raw response. Assert none appear in Tool JSON, thrown error messages, status HTML, or logger calls. The safe file ID may appear only in list/confirmation results, not in logs.

- [ ] **Step 8: Run integration and complete unit tests**

Run:

```powershell
npm test -- --run tests/integration/tool.test.ts tests/integration/plugin-entry.test.ts tests/integration/leakage.test.ts
npm run test:unit
```

Expected: PASS.

- [ ] **Step 9: Commit Tool integration**

```powershell
git add src/read/tool.ts src/runtime-composition.ts src/index.ts openclaw.plugin.json tests/integration/tool.test.ts tests/integration/plugin-entry.test.ts tests/integration/leakage.test.ts
git commit -m "feat: register resource drive read tools"
```

---

### Task 6: Expand the published Skill for bilingual upload and read intent

**Files:**

- Modify: `skills/pan-sync-upload/SKILL.md`
- Modify: `tests/integration/tool.test.ts`

**Interfaces:**

- Produces conversation policy for `pan_sync_upload`, `pan_sync_list`, and `pan_sync_download` while preserving the published skill name `pan-sync-upload`.

- [ ] **Step 1: Replace the old Skill assertion with failing bilingual behavior assertions**

Assert the Skill contains all approved intent groups and examples:

```ts
expect(contents).toContain("上传");
expect(contents).toContain("upload");
expect(contents).toContain("列出");
expect(contents).toContain("search");
expect(contents).toContain("读取");
expect(contents).toContain("download");
expect(contents).toContain("同步到");
expect(contents).toContain("sync to");
expect(contents).toContain("从网盘同步下来");
expect(contents).toContain("sync from");
expect(contents).toContain("DOWNLOAD_CONFIRMATION_REQUIRED");
```

Assert it explicitly requires clarification for `同步网盘` and `sync cloud drive`, requires user selection for multiple results, and contains discussion-only negative examples in both languages.

- [ ] **Step 2: Run the Skill discovery test and verify RED**

Run:

```powershell
npm test -- --run tests/integration/tool.test.ts -t "Skill discovery contract"
```

Expected: FAIL because the current Skill only covers upload and has an English-only frontmatter description.

- [ ] **Step 3: Rewrite the Skill as a bilingual decision flow**

Keep LF line endings and this frontmatter identity:

```yaml
---
name: pan-sync-upload
description: Upload, list, search, download, and read Aliyun Drive files from OpenClaw when the user explicitly requests a cloud-drive operation in Chinese or English.
---
```

Order the body as:

1. Provider aliases.
2. Upload intent and tool call.
3. List/search intent and tool call.
4. Download/read intent and tool call.
5. Exact-path versus query flow.
6. Multiple-result clarification.
7. More-than-100-MiB explicit confirmation.
8. Directional sync rules.
9. Discussion-only negative examples.
10. Credential recovery guidance.

- [ ] **Step 4: Run Skill, repository, and package-preflight tests**

Run:

```powershell
npm test -- --run tests/integration/tool.test.ts tests/unit/repository-config.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit the bilingual Skill**

```powershell
git add skills/pan-sync-upload/SKILL.md tests/integration/tool.test.ts
git commit -m "docs: add bilingual drive intents"
```

---

### Task 7: Build the bilingual quick-start and screenshot package contract

**Files:**

- Modify: `README.md`
- Modify: `package.json`
- Modify: `tests/integration/package.test.ts`
- Create: `docs/images/readme/01-plugin-ready.png`
- Create: `docs/images/readme/02-upload-resource-drive.png`
- Create: `docs/images/readme/03-search-resource-drive.png`
- Create: `docs/images/readme/04-download-and-read.png`

**Interfaces:**

- Produces a packaged README with `#中文快速上手` and `#english-quick-start` navigation targets.
- Produces four real PNG screenshots referenced by relative links and shipped in the npm package.

- [ ] **Step 1: Write failing README and image package tests**

In `tests/integration/package.test.ts`, assert the packed README includes:

```text
[中文](#中文快速上手)
[English](#english-quick-start)
## 中文快速上手
## English quick start
pan_sync_upload
pan_sync_list
pan_sync_download
资源盘
resource drive
DOWNLOAD_CONFIRMATION_REQUIRED
```

Require the four exact PNG paths in the package report. For every PNG, read the packed bytes, verify the PNG signature, read non-zero width and height from IHDR, and require each image to be smaller than 2 MiB. Continue using `localMarkdownTargets` so every README image target must exist in the tarball.

Add a binary tar helper rather than decoding PNG bytes as UTF-8:

```ts
function readPackedBuffer(tarball: string, packagePath: string): Buffer {
  const extracted = spawnSync(
    "tar",
    ["-xOf", tarball, `package/${packagePath}`],
    { encoding: null, timeout: 10_000 },
  );
  if (extracted.error !== undefined || extracted.status !== 0) {
    throw new Error(`could not read packed asset: ${packagePath}`);
  }
  return extracted.stdout;
}
```

- [ ] **Step 2: Run package tests and verify RED**

Run:

```powershell
npm test -- --run tests/integration/package.test.ts
```

Expected: FAIL because the bilingual sections, images, and package file entry are absent.

- [ ] **Step 3: Prepare a sanitized real test scenario**

Use a dedicated Aliyun test account and benign filenames:

```text
pan-sync-demo-en.txt
网盘读取示例.txt
large-confirmation-demo.bin
```

Before launching UI capture, ensure no command, page, prompt, or filename contains a real user name, host name, absolute path, Token, one-time fragment, dynamic port, or file ID. Do not place raw Shell or service-log panes inside the capture region.

- [ ] **Step 4: Capture the four real screenshots during the test flow**

Use the OpenClaw app/browser control skill required by the active environment. Capture:

1. Installed plugin and safe `ready` status.
2. A successful upload whose visible destination is the resource drive.
3. A resource-drive root listing or filename search with safe demo entries.
4. A completed download followed by OpenClaw reading the workspace file.

Save the exact PNG filenames from the Files block. Inspect every image at original resolution before use. If a forbidden value appears, discard the image, change the test presentation, and recapture; do not retain the unsafe source image in the repository.

- [ ] **Step 5: Write the complete Chinese quick start**

Use this exact journey:

```text
插件价值与边界 → 环境要求 → 安装 → OpenList 配置 → ready 状态 →
第一次上传 → 列出/搜索 → 下载并读取 → 大文件确认 → 恢复与安全 → 已知限制
```

Include copyable commands, Chinese natural-language examples, discussion-only negative examples, resource-drive-only behavior, root-directory download default, collision naming, and the 100 MiB confirmation flow. Place each screenshot beside the step it demonstrates.

- [ ] **Step 6: Write the complete English quick start**

Mirror every Chinese section in the same order. Use natural English rather than sentence-by-sentence machine translation. Include upload, list, search, download/read, ambiguous `sync cloud drive`, and discussion-only examples.

- [ ] **Step 7: Publish only the approved image directory**

Add to `package.json.files`:

```json
"docs/images/readme"
```

Extend `packageViolations` with an exact allowlist for the four README PNGs; reject other files under `docs/images/readme`, including unsafe capture leftovers.

- [ ] **Step 8: Run README and package tests and verify GREEN**

Run:

```powershell
npm test -- --run tests/integration/package.test.ts tests/integration/tool.test.ts
npm run build
npm pack --dry-run
```

Expected: PASS; all relative README targets are present in the packed artifact and only the four approved images ship.

- [ ] **Step 9: Commit bilingual documentation and screenshots**

```powershell
git add README.md package.json tests/integration/package.test.ts docs/images/readme/01-plugin-ready.png docs/images/readme/02-upload-resource-drive.png docs/images/readme/03-search-resource-drive.png docs/images/readme/04-download-and-read.png
git commit -m "docs: add bilingual pan sync quick start"
```

---

### Task 8: Run full gates and record real resource-drive acceptance

**Files:**

- Create: `docs/superpowers/verification/2026-08-02-resource-drive-read.md`

**Interfaces:**

- Produces sanitized evidence with independent automated, OpenClaw integration, real Aliyun, screenshot, package, and release statuses.

- [ ] **Step 1: Run the complete automated gate from fresh output**

Run:

```powershell
npm run verify
```

Expected:

```text
TypeScript typecheck: PASS
Unit tests: PASS
Integration tests: PASS
Build: PASS
npm pack --dry-run: PASS
```

Do not infer this result from earlier focused tests; record the fresh command result.

- [ ] **Step 2: Inspect the exact package artifact**

Pack into a unique temporary directory, inspect the tarball, and remove only that exact temporary directory afterward:

```powershell
$packRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("pan-sync-read-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $packRoot | Out-Null
$pack = npm pack --json --pack-destination $packRoot | ConvertFrom-Json
$tarball = Join-Path $packRoot $pack[0].filename
tar -tf $tarball
```

Confirm `dist/tool.js`, `dist/read/tool.js`, one Skill, the bilingual README, four images, and the token guide are present; confirm tests, source, runtime state, keys, credentials, and extra screenshots are absent.

- [ ] **Step 3: Run installed OpenClaw smoke testing**

Install that exact tarball into an isolated OpenClaw state. Confirm the plugin loads without diagnostics, all three tools are discoverable, the CLI configure command still works, and status remains gateway-protected. Keep dynamic ports, state paths, and raw output out of the verification document.

- [ ] **Step 4: Run the real Aliyun resource-drive matrix**

With the dedicated account:

1. Upload `pan-sync-demo-en.txt` and confirm it appears only in the resource drive.
2. List `/` and find both safe demo files.
3. Search by Chinese and English text and continue a paginated search once.
4. Download a demo file and compare SHA-256 with the source.
5. Download it again and confirm `name (1).ext` without modifying the first file.
6. Request the 100-MiB-plus file, confirm no file is created before approval, approve once, then confirm download.
7. Use one Chinese upload/read request and one English upload/read request.
8. Confirm the backup drive contains none of the new acceptance files.
9. Inspect sanitized Tool output and logs for token, URL, drive ID, file ID, and absolute-path leakage.

- [ ] **Step 5: Re-run both README journeys**

Follow the Chinese quick start from installation through first read, then repeat with the English quick start in a fresh isolated state. Confirm every command copies successfully, every screenshot matches the current interface, and no step relies on knowledge absent from the README.

- [ ] **Step 6: Write the verification record**

Use this exact status block:

```text
Automated gate: PASS/FAIL
OpenClaw integration gate: PASS/FAIL
Real Aliyun resource-drive gate: PASS/FAIL/NOT RUN
Chinese README journey: PASS/FAIL/NOT RUN
English README journey: PASS/FAIL/NOT RUN
Screenshot sanitization gate: PASS/FAIL
Package inspection gate: PASS/FAIL
Release decision: READY/BLOCKED
```

Record versions, the package SHA-256, test counts, and sanitized observations. Do not record secrets, dynamic ports, file IDs, local absolute paths, account identity, or raw logs. `NOT RUN` for the real account or either README journey keeps `Release decision: BLOCKED`.

- [ ] **Step 7: Run final repository checks**

Run:

```powershell
git diff --check
git status --short
npm run verify
```

Expected: no unexpected changed files, no whitespace failures, and a second fresh full gate PASS.

- [ ] **Step 8: Commit the verification record**

```powershell
git add docs/superpowers/verification/2026-08-02-resource-drive-read.md
git commit -m "docs: verify resource drive read release"
```
