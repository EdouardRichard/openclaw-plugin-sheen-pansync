# Aliyun Sequential Multipart and Setup Localization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix real Aliyun multipart uploads by sending parts sequentially, and deliver a secure setup page that defaults to Simplified Chinese with an in-page English switch and localized descriptions around unchanged status/error codes.

**Architecture:** Keep the Provider, Tool, API, credential, and error-code contracts unchanged. Replace only the multipart worker pool with one ordered streaming loop, and localize the existing single setup document with fixed client-side dictionaries and safe DOM assignment.

**Tech Stack:** TypeScript 5.9, Node.js 22.23.1 verification runtime, Node.js 24.18.1 live OpenClaw runtime, Vitest 3.2, JSDOM 29, vanilla HTML/CSS/JavaScript, OpenClaw 2026.7.1-2.

## Global Constraints

- Work only in `D:\Project_new\openClaw-panSyncHelper\.worktrees\full-flow-acceptance` for source changes.
- Do not commit, push, create a pull request, publish, or delete any remote acceptance file.
- Preserve all public TypeScript interfaces, HTTP payloads, Tool result fields, and raw status/error codes.
- Do not add automatic network retries, real rate-limit tests, remote assets, inline scripts, or weaker CSP rules.
- Use `apply_patch` for source, test, and documentation edits.
- Run Node-based repository verification through `volta run --node 22.23.1`.
- Rebuild and reinstall one exact archive before any additional real upload.
- Retry the failed 41 MiB real upload exactly once after all local gates pass.
- Never print or inspect Refresh Token, Access Token, encrypted credential contents, setup fragment keys, or raw Gateway logs.

---

### Task 1: Enforce Sequential Aliyun Multipart Uploads

**Files:**

- Modify: `tests/unit/aliyun-upload.test.ts`
- Modify: `src/providers/aliyun/upload.ts`

**Interfaces:**

- Consumes: `uploadAliyunFile(client, input, clock, options)` and the existing fake Aliyun upload server.
- Produces: the same `Promise<ProviderUploadResult>` with ordered part PUTs, bounded streaming reads, unchanged error mapping, and unchanged completion behavior.

- [ ] **Step 1: Change the multipart success test to encode the real sequential contract**

In `tests/unit/aliyun-upload.test.ts`, rename the 45 MiB success test to `streams a 45 MiB descriptor in sequential 20 MiB parts before completing` and assert all of the following:

```ts
expect(create?.body).toMatchObject({
  parallel_upload: false,
  size: 45 * MIB,
  part_info_list: [
    { part_number: 1 },
    { part_number: 2 },
    { part_number: 3 },
  ],
});
expect(server.maxConcurrentPuts()).toBe(1);
expect(server.events).toEqual([
  "put-1-start",
  "put-1-end",
  "put-2-start",
  "put-2-end",
  "put-3-start",
  "put-3-end",
  "complete",
]);
```

Replace the separate `limits concurrent part PUTs to three` test with `never starts the next part before the preceding PUT ends`. Use `holdPutsMs: 25` and assert `maxConcurrentPuts()` is exactly `1` and every `put-N-end` precedes `put-(N+1)-start`.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
volta run --node 22.23.1 npm test -- --run tests/unit/aliyun-upload.test.ts
```

Expected: FAIL because the create request contains `parallel_upload: true`, maximum concurrency is `3`, or part start events occur before the preceding end event. No assertion may fail because of a fixture or syntax error.

- [ ] **Step 3: Implement the minimal sequential uploader**

In `src/providers/aliyun/upload.ts`:

- Remove `MAX_CONCURRENT_PUTS`.
- Send `parallel_upload: false` in the create request.
- Replace the worker pool in `uploadParts` with one `for (const originalPart of upload.parts)` loop.
- Preserve signed-URL refresh, positional range calculation, exact `Content-Length`, linked caller cancellation, token replacement, and immediate failure propagation.

The loop must follow this shape:

```ts
let accessToken = initialAccessToken;
const cancellation = new AbortController();
const abortFromExternal = (): void => cancellation.abort(externalSignal?.reason);

if (externalSignal?.aborted === true) abortFromExternal();
else externalSignal?.addEventListener("abort", abortFromExternal, { once: true });

try {
  for (const originalPart of upload.parts) {
    if (cancellation.signal.aborted) {
      throw new PanSyncError("UPLOAD_FAILED");
    }
    let part = originalPart;
    if (clock() - part.acquiredAt >= UPLOAD_URL_REFRESH_AGE_MS) {
      const refreshed = await client.post(
        "/adrive/v1.0/openFile/getUploadUrl",
        accessToken,
        {
          drive_id: input.remoteDirectory.providerState.driveId,
          file_id: upload.fileId,
          upload_id: upload.uploadId,
          part_info_list: [{ part_number: part.partNumber }],
        },
        { failureCode: "UPLOAD_FAILED", signal: cancellation.signal },
      );
      accessToken = refreshed.accessToken;
      part = parseRefreshedPartUrl(refreshed.body, part.partNumber, clock());
    }
    const start = (part.partNumber - 1) * partSize;
    const length = Math.min(partSize, input.file.size - start);
    if (length <= 0) throw new PanSyncError("UPLOAD_FAILED");
    await putPart(
      client,
      rangeStream(input.file, start, length),
      part.uploadUrl,
      length,
      cancellation.signal,
    );
  }
  return accessToken;
} finally {
  externalSignal?.removeEventListener("abort", abortFromExternal);
}
```

- [ ] **Step 4: Verify GREEN and focused regression coverage**

Run:

```powershell
volta run --node 22.23.1 npm test -- --run tests/unit/aliyun-upload.test.ts
```

Expected: every Aliyun upload test passes, including URL refresh, cancellation, rate-limit mapping, capacity mapping, zero-byte upload, stream boundaries, and the ProviderRegistry contract.

- [ ] **Step 5: Review the source diff for scope and unsafe retry behavior**

Run:

```powershell
git diff -- src/providers/aliyun/upload.ts tests/unit/aliyun-upload.test.ts
rg -n "MAX_CONCURRENT_PUTS|parallel_upload|Promise\.all|retry" src/providers/aliyun/upload.ts tests/unit/aliyun-upload.test.ts
```

Expected: no worker pool remains, `parallel_upload` is `false`, no retry loop was added, and no unrelated provider behavior changed.

---

### Task 2: Add Default-Chinese Setup Page Localization

**Files:**

- Modify: `ui/setup.html`
- Modify: `ui/setup.js`
- Modify: `ui/setup.css`
- Modify: `tests/integration/admin-server.test.ts`

**Interfaces:**

- Consumes: the existing setup API codes and `loadSetupPage` JSDOM harness.
- Produces: a `zh-CN` default page with a `中文 / English` toggle, localized static/dynamic copy, and unchanged API requests and raw codes.

- [ ] **Step 1: Add failing default-language and toggle tests**

Add a JSDOM integration test named `defaults to Chinese and switches all setup copy to English without changing credentials` that:

```ts
expect(page.dom.window.document.documentElement.lang).toBe("zh-CN");
expect(page.dom.window.document.querySelector("h1")?.textContent)
  .toBe("连接阿里云盘");

const token = page.dom.window.document.getElementById("refreshToken") as HTMLInputElement;
token.value = "language-switch-token-CANARY";
(page.dom.window.document.getElementById("languageToggle") as HTMLButtonElement).click();

expect(page.dom.window.document.documentElement.lang).toBe("en");
expect(page.dom.window.document.querySelector("h1")?.textContent)
  .toBe("Connect Aliyun Drive");
expect(token.value).toBe("language-switch-token-CANARY");
expect(page.dom.window.document.body.textContent)
  .not.toContain("language-switch-token-CANARY");
```

Assert the English pass covers the risk warning, three labels, authorization link, five action buttons, two notes, title, and language-control accessibility label.

- [ ] **Step 2: Add failing localized-status tests with unchanged codes**

Add a test named `localizes safe descriptions while retaining exact status and error codes`.

Drive the page through initial ready, `SAVED_AND_VERIFIED`, and a rejected request with `REQUEST_FAILED`. Assert:

```ts
expect(result.textContent).toBe("配置页面已就绪（READY）");
expect(result.textContent).toBe("已保存并验证（SAVED_AND_VERIFIED）");
expect(result.textContent).toBe("请求失败；配置会话可能已过期（REQUEST_FAILED）");
```

After clicking `languageToggle`, assert the last result rerenders as:

```ts
expect(result.textContent)
  .toBe("Request failed; the setup session may have expired (REQUEST_FAILED)");
```

Also table-test these unchanged error codes in both dictionaries: `CREDENTIALS_REQUIRED`, `CREDENTIALS_INVALID`, `REFRESH_TOKEN_REJECTED`, `TOKEN_ENDPOINT_UNAVAILABLE`, `RATE_LIMITED`, `UPLOAD_FAILED`, and `REQUEST_FAILED`.

- [ ] **Step 3: Run the setup-page tests and verify RED**

Run:

```powershell
volta run --node 22.23.1 npm test -- --run tests/integration/admin-server.test.ts
```

Expected: FAIL because `html.lang` is `en`, `languageToggle` is absent, static copy is English-only, and result text is a raw code. Existing security tests must still execute without fixture errors.

- [ ] **Step 4: Add stable localization hooks and the language control**

In `ui/setup.html`:

- Set `<html lang="zh-CN">` and a Chinese initial `<title>`.
- Add `id` values or `data-i18n` keys to every user-facing static element.
- Add `<button id="languageToggle" type="button" class="language-toggle">中文 / English</button>` before the heading.
- Keep the existing form field ids, input types, `autocomplete`, link security attributes, result live region, external stylesheet, and deferred external script.
- Make the literal HTML fallback copy Chinese so the default is correct before JavaScript executes.

In `ui/setup.css`, add only layout styles for `.language-toggle`; preserve the existing colors, focus behavior, danger styles, and responsive layout.

- [ ] **Step 5: Implement the fixed bilingual dictionary and safe renderer**

In `ui/setup.js`, define:

```js
const translations = {
  "zh-CN": {
    title: "Pan Sync Helper 配置",
    heading: "连接阿里云盘",
    working: "处理中…",
    READY: "配置页面已就绪",
    SAVED_AND_VERIFIED: "已保存并验证",
    REVALIDATED: "重新验证完成",
    TEST_UPLOAD_COMPLETE: "测试上传完成",
    CREDENTIALS_CLEARED: "凭据已清除",
    CREDENTIALS_REQUIRED: "尚未配置凭据",
    CREDENTIALS_INVALID: "凭据无效",
    REFRESH_TOKEN_REJECTED: "Refresh Token 被拒绝",
    TOKEN_ENDPOINT_UNAVAILABLE: "Token 服务暂时不可用",
    RATE_LIMITED: "请求受到限流，请稍后再试",
    UPLOAD_FAILED: "上传失败",
    REQUEST_FAILED: "请求失败；配置会话可能已过期",
  },
  en: {
    title: "Pan Sync Helper configuration",
    heading: "Connect Aliyun Drive",
    working: "Working…",
    READY: "Configuration page ready",
    SAVED_AND_VERIFIED: "Saved and verified",
    REVALIDATED: "Revalidation complete",
    TEST_UPLOAD_COMPLETE: "Test upload complete",
    CREDENTIALS_CLEARED: "Credentials cleared",
    CREDENTIALS_REQUIRED: "Credentials are not configured",
    CREDENTIALS_INVALID: "Credentials are invalid",
    REFRESH_TOKEN_REJECTED: "Refresh Token was rejected",
    TOKEN_ENDPOINT_UNAVAILABLE: "Token service is unavailable",
    RATE_LIMITED: "Request rate limited; try again later",
    UPLOAD_FAILED: "Upload failed",
    REQUEST_FAILED: "Request failed; the setup session may have expired",
  },
};
```

Add every static-copy key to the same objects. Initialize `currentLanguage` to `"zh-CN"`, retain `lastResultCode`, update `document.documentElement.lang` and `document.title`, and render fixed strings using `textContent`. Render bounded dynamic values as `description + full-width parentheses + code` in Chinese and `description + parentheses + code` in English. Never interpolate API bodies, exception messages, URLs, or credential values into localized HTML.

The toggle handler must only change `currentLanguage`, rerender static copy, and rerender `lastResultCode`. It must not call `clearFormValues`, `invalidateRequests`, `api`, or form submission.

- [ ] **Step 6: Verify localization GREEN and anti-leakage behavior**

Run:

```powershell
volta run --node 22.23.1 npm test -- --run tests/integration/admin-server.test.ts
volta run --node 22.23.1 npm run test:leakage
```

Expected: all admin-server and leakage tests pass; raw error canaries remain absent from the DOM/error arrays; the token canary survives a language switch only inside the input value and never appears in page text or console output.

- [ ] **Step 7: Review localization scope and CSP boundaries**

Run:

```powershell
git diff -- ui/setup.html ui/setup.js ui/setup.css tests/integration/admin-server.test.ts
rg -n "innerHTML|localStorage|navigator\.language|fetch\(|<script[^>]*>[^<]" ui tests/integration/admin-server.test.ts
```

Expected: no `innerHTML`, language persistence, browser auto-detection, new network request, inline script, raw-code change, or credential mutation was added.

---

### Task 3: Run Full Gates and Build a New Exact Artifact

**Files:**

- Read: all changed source and tests.
- Create: `.acceptance-artifacts/20260802T-sequential-i18n-fix/openclaw-pan-sync-helper-0.1.0.tgz`

**Interfaces:**

- Consumes: Tasks 1 and 2 GREEN source tree.
- Produces: one verified archive with a fresh SHA-256, size, entry count, and bounded package contents.

- [ ] **Step 1: Run focused and complete repository gates**

Run:

```powershell
volta run --node 22.23.1 npm run typecheck
volta run --node 22.23.1 npm run test:unit
volta run --node 22.23.1 npm run test:integration
volta run --node 22.23.1 npm run build
volta run --node 22.23.1 npm run verify
git diff --check
```

Expected: every command exits `0`, all test counts are recorded, build succeeds, package dry-run succeeds, and no whitespace errors are present.

- [ ] **Step 2: Create a new isolated package directory and archive**

Create `.acceptance-artifacts/20260802T-sequential-i18n-fix`, then run:

```powershell
volta run --node 22.23.1 npm pack --pack-destination ".acceptance-artifacts\20260802T-sequential-i18n-fix"
```

Expected: the new directory contains exactly one `openclaw-pan-sync-helper-0.1.0.tgz`. Do not reuse or overwrite the original `20260802T072557Z` archive.

- [ ] **Step 3: Verify artifact identity and package boundary**

Record SHA-256, byte size, and tar entry count. Inspect entry names only and assert the archive includes `dist`, `ui`, `skills`, `openclaw.plugin.json`, and the documented guide, while excluding `src`, `tests`, `node_modules`, `.env`, `master.key`, `credentials.enc`, `.superpowers`, and `.acceptance-artifacts`.

Expected: one internally consistent final archive and zero forbidden entries.

- [ ] **Step 4: Reinstall that exact archive into live OpenClaw**

Use the absolute global Node and OpenClaw CLI paths from the accepted environment:

```powershell
& "C:\Users\Richard\AppData\Local\Volta\tools\image\node\24.18.1\node.exe" `
  "C:\Users\Richard\AppData\Local\Volta\tools\image\packages\openclaw\node_modules\openclaw\openclaw.mjs" `
  plugins install --force "D:\Project_new\openClaw-panSyncHelper\.worktrees\full-flow-acceptance\.acceptance-artifacts\20260802T-sequential-i18n-fix\openclaw-pan-sync-helper-0.1.0.tgz"
```

Restart the Gateway, then run `gateway health`, `plugins inspect pan-sync-helper --runtime --json`, `plugins doctor`, and `skills info pan-sync-upload --json` with the same global CLI.

Expected: Gateway `OK`; plugin loaded/enabled/activated; `pan_sync_upload`, `pan-sync`, one HTTP route, one service, and the eligible Skill are present; diagnostics are empty; credential files remain present without reauthorization.

---

### Task 4: Resume Live Acceptance and Finish the Release Gate

**Files:**

- Read only: bounded OpenClaw status/inspect envelopes and dedicated acceptance-session results.
- Create: `C:\Users\Richard\.openclaw\workspace\pan-sync-acceptance-20260802T072557Z\restart-probe.txt`
- Create: final Chinese verification record under `docs/superpowers/verification/`.

**Interfaces:**

- Consumes: the exact final archive installed in Task 3 and the existing encrypted live credentials.
- Produces: live UI, multipart, partial-result, intent-routing, restart-persistence, and leakage evidence plus a final verdict.

- [ ] **Step 1: Verify the live default-Chinese page and English switch**

Launch one fresh `pan-sync configure` session, confirm its listener is only `127.0.0.1`, and open it with the in-app browser. Inspect only these bounded facts:

- title/heading and `html.lang` are Chinese/`zh-CN` by default;
- the visible control reads `中文 / English`;
- switching produces the complete English page and `html.lang="en"`;
- the Refresh Token input length and equality-before/after are unchanged, but its value is never returned;
- switching causes no request, console error, or credential write;
- the page still reports the ready state with its unchanged raw code.

Close the exact setup session and confirm its listener is gone.

- [ ] **Step 2: Retry the 41 MiB upload exactly once**

Use a new dedicated OpenClaw acceptance session and request one `pan_sync_upload` call for `pan-sync-acceptance-20260802T072557Z/multipart-41m.bin`. Do not use `exec`, `curl`, or an alternative upload path.

Expected: one Tool call succeeds, remote name is reported, and exact size is `42,991,616` bytes. If it fails, stop real external testing and return to systematic debugging without retrying again.

- [ ] **Step 3: Complete the remaining real upload matrix**

Run one partial request containing `small-en.txt` and nonexistent `missing.txt`.

Expected: existing file succeeds under a distinct auto-renamed remote name, missing file returns unchanged `FILE_NOT_FOUND`, overall status is partial, and no normalized path is uploaded twice.

Ask one cloud-drive discussion question with no upload/sync/push verb.

Expected: no `pan_sync_upload` Tool call and no remote file.

- [ ] **Step 4: Verify restart persistence**

Create `restart-probe.txt` with run-id-only content through `apply_patch`. Restart the Gateway and re-run health/plugin/Skill checks, then request exactly one Tool upload of the probe.

Expected: no reauthorization is needed, the Tool remains reachable through the `coding` profile plus exact `tools.alsoAllow`, and the upload succeeds.

- [ ] **Step 5: Run final leakage and repository checks**

Run the repository leakage suite, full `npm run verify`, `git diff --check`, and bounded scans of status/agent envelopes for forbidden credential key names. Inspect only file names, sizes, ACL summaries, and safe status projections for live credential state.

Expected: no plaintext credentials, setup keys, signed upload URLs, raw third-party bodies, or canary secrets appear in repository artifacts, package entries, status output, Tool results, or the verification record.

- [ ] **Step 6: Write and self-review the Chinese verification record**

Record: reviewed commit/worktree; Node/OpenClaw/plugin versions; final archive SHA-256/size/entry count; automated test counts; isolated/live registration; tool-policy defect and fix; sequential multipart RED/GREEN; setup localization RED/GREEN; real upload matrix; restart recovery; leakage result; remote acceptance-file names/count/sizes without links or IDs; skipped real rate-limit row; and final PASS/BLOCKED verdict.

Scan the record for unfinished placeholder markers, raw credentials, full configured URLs, setup fragments, signed URLs, dynamic identifiers, and unsanitized logs. Any applicable failure or unverified hard gate forces `BLOCKED` rather than PASS.

No Git commit, push, pull request, publication, remote deletion, or backup deletion is part of this plan.
