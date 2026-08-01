# OpenList Token Service Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace personal Aliyun OAuth application credentials with OpenList APIPages authorization and strictly reactive Token refresh while keeping file uploads direct to Aliyun Drive.

**Architecture:** Add an `OpenListTokenService` that implements the current OpenList Aliyun online-renew contract, then atomically cut the Vault, setup page, Provider validation, and runtime composition to the new credential model. The Provider refreshes only after explicit Aliyun access-token error codes; `TokenManager` serializes refreshes in-process and across processes, persists cooldown state, and never proactively refreshes by time.

**Tech Stack:** Node.js 22.23.1, TypeScript ESM, native `fetch`, AES-256-GCM Credential Vault, Node SQLite Worker leases, OpenClaw Plugin SDK `2026.7.1-2`, Vitest 3.2.

## Global Constraints

- OpenList participates only in authorization and Token renewal; file bytes continue to go directly from the plugin to `https://openapi.alipan.com`.
- Initial configuration is external OpenList authorization plus manual `refresh_token` paste; do not add QR polling or an OAuth callback to the plugin.
- Default authorization page URL is `https://api.oplist.org.cn`.
- Default refresh API URL is `https://api.oplist.org.cn/alicloud/renewapi`.
- Both URLs are complete, independently editable values. Do not derive one from the other and do not append a path.
- Do not restrict custom URL scheme, host, IP, port, user info, or network range beyond the URL/fetch behavior required to make a request.
- Remove `client_id`, `client_secret`, `accessTokenExpiresAt`, and ordinary-config `tokenGuideUrl`; do not implement a legacy credential mode or migration.
- First save may call OpenList once because no access token exists. Runtime renewal occurs only after an explicit Aliyun access-token failure.
- OpenList requests use `GET` with `refresh_ui`, `server_use=true`, and `driver_txt=alicloud_qr`, time out after 15 seconds, and have no immediate retry.
- Persist both returned Tokens atomically. Never persist only one Token from a response.
- Do not automatically switch among mainland, global, or custom OpenList endpoints.
- A 429 uses valid `Retry-After` or a 60-minute fallback; network/timeout/5xx uses a one-minute cooldown; invalid Token responses require reauthorization.
- Refresh cooldown survives OpenClaw restart and concurrent processes share one upstream refresh.
- The loopback setup page continues to show the full refresh token and both URLs. Access tokens never appear in setup responses or fields.
- Token values, complete configured URLs, remote response bodies, stack traces, and absolute workspace paths stay out of logs, Tool results, Control UI, and safe errors.
- Keep one Aliyun account, default directory `/openClawShare`, `auto_rename`, Provider aliases, path confinement, upload concurrency, and all non-authentication behavior unchanged.
- Preserve user-owned untracked `dist/` and `node_modules/`; stage only files named by each task.
- Use `volta run --node 22.23.1` for all Node/npm gates.

## File Map

### New files

- `src/providers/aliyun/openlist-token-service.ts` — OpenList renew request, timeout, response validation, and Retry-After parsing.
- `src/providers/aliyun/constants.ts` — Aliyun file API and default OpenList URL constants shared without retaining the old OAuth client.
- `tests/helpers/fake-openlist-server.ts` — deterministic request/response recorder for OpenList contract tests.
- `tests/unit/openlist-token-service.test.ts` — protocol, failure mapping, cancellation, and leakage tests.
- `tests/helpers/token-refresh-child.mjs` — child-process entry used to prove cross-process refresh serialization.
- `tests/integration/token-refresh-process.test.ts` — shared-Vault, shared-lease, one-upstream-call integration gate.
- `docs/verification/2026-08-01-openlist-token-service.md` — automated, OpenClaw, browser, real-service, and release verdicts.

### Modified or removed files

- `src/credentials/types.ts` — version-2 credential and persisted refresh-state schema.
- `src/contracts.ts` — configuration input without client credentials.
- `src/credentials/crypto.ts` — version-2 credential AAD; no legacy decrypt path.
- `src/errors.ts` — internal retry metadata while safe serialization remains code-only.
- `src/providers/aliyun/types.ts` — shared fetch type only; remove personal-OAuth refresh types.
- `src/providers/aliyun/http.ts` — remove after all consumers use `OpenListTokenService`.
- `src/credentials/token-manager.ts` — reactive access-token selection, cross-process refresh lease, CAS rotation, and persisted cooldown.
- `src/providers/aliyun/provider.ts` — initial OpenList refresh plus Aliyun account validation.
- `src/providers/aliyun/upload.ts` — exact Aliyun Token error recognition and one retry.
- `src/runtime-composition.ts` — instantiate one OpenList service and pass the SQLite lease runner to TokenManager.
- `src/config.ts`, `src/index.ts`, `src/cli-entry.ts`, `openclaw.plugin.json` — remove `tokenGuideUrl` and obsolete plumbing.
- `src/admin/setup-server.ts`, `ui/setup.html`, `ui/setup.js`, `ui/setup.css` — new configuration fields, warning, link, full re-display, and safe failure handling.
- `src/admin/status-route.ts` — OpenList service label, five bounded statuses, no Client ID or URL.
- Unit and integration tests — replace legacy fixtures, add reactive-refresh/cooldown/leakage coverage.
- `README.md`, `docs/guides/aliyun-token.md`, `docs/plans/token-acquisition-web-system.md` — make OpenList the current user journey and mark the former custom-app web plan superseded.

---

### Task 1: Add the isolated OpenList renewal client

**Files:**

- Create: `src/providers/aliyun/openlist-token-service.ts`
- Create: `tests/helpers/fake-openlist-server.ts`
- Create: `tests/unit/openlist-token-service.test.ts`
- Modify: `src/errors.ts`
- Modify: `src/providers/aliyun/types.ts`

**Interfaces:**

- Consumes: native `fetch`, `PanSyncError`, `AliyunFetch`.
- Produces:

```ts
export const DEFAULT_OPENLIST_AUTHORIZATION_PAGE_URL = "https://api.oplist.org.cn";
export const DEFAULT_OPENLIST_REFRESH_API_URL = "https://api.oplist.org.cn/alicloud/renewapi";

export type OpenListRefreshInput = {
  refreshApiUrl: string;
  refreshToken: string;
  signal?: AbortSignal;
};

export type OpenListRefreshResult = {
  accessToken: string;
  refreshToken: string;
};

export interface AliyunTokenService {
  refresh(input: OpenListRefreshInput): Promise<OpenListRefreshResult>;
}

export class OpenListTokenService implements AliyunTokenService {
  constructor(options?: {
    fetch?: AliyunFetch;
    clock?: () => number;
    scheduleTimeout?: typeof setTimeout;
    cancelTimeout?: typeof clearTimeout;
  });
  refresh(input: OpenListRefreshInput): Promise<OpenListRefreshResult>;
}
```

- `PanSyncError` gains optional internal-only `retryAfterMs?: number`; `safeErrorDetails()` still returns exactly `{ code }`.

- [ ] **Step 1: Write the failing protocol tests**

Add a fake HTTP server that records method, raw request URL, headers, and body, and supports queued `status`, `headers`, `body`, and `hang` responses. Add tests with these exact assertions:

```ts
expect(request.method).toBe("GET");
expect(new URL(request.url).searchParams.get("refresh_ui")).toBe("refresh-CANARY");
expect(new URL(request.url).searchParams.get("server_use")).toBe("true");
expect(new URL(request.url).searchParams.get("driver_txt")).toBe("alicloud_qr");
expect(request.body).toBe("");
expect(result).toEqual({
  accessToken: "access-2",
  refreshToken: "refresh-2",
});
```

Also assert that an input URL containing `/custom/renew?tenant=one` keeps that path and existing query while receiving the three OpenList parameters.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```powershell
volta run --node 22.23.1 npm exec -- vitest run tests/unit/openlist-token-service.test.ts
```

Expected: FAIL because `openlist-token-service.ts` and `startFakeOpenListServer` do not exist.

- [ ] **Step 3: Implement the request and strict response contract**

Build the URL with `new URL(input.refreshApiUrl)` and `searchParams.set`. Send no authorization header and no request body. Parse JSON without returning raw parse failures. Map results exactly:

```ts
if (response.status === 429) {
  throw new PanSyncError("RATE_LIMITED", {
    retryAfterMs: parseRetryAfter(response.headers.get("retry-after"), clock()),
  });
}
if (response.status >= 500) {
  throw new PanSyncError("TOKEN_ENDPOINT_UNAVAILABLE");
}
if (!response.ok) {
  throw new PanSyncError("REFRESH_TOKEN_REJECTED");
}
if (!isNonEmptyString(body.access_token) || !isNonEmptyString(body.refresh_token)) {
  throw new PanSyncError("REFRESH_TOKEN_REJECTED");
}
```

Parse `Retry-After` as non-negative delta-seconds or a future HTTP-date. Invalid, negative, or past values return `undefined`, allowing TokenManager to apply the 60-minute fallback.

- [ ] **Step 4: Add failure, cancellation, and leakage cases**

Use `it.each` to cover:

```ts
[
  [400, "REFRESH_TOKEN_REJECTED"],
  [401, "REFRESH_TOKEN_REJECTED"],
  [404, "REFRESH_TOKEN_REJECTED"],
  [500, "TOKEN_ENDPOINT_UNAVAILABLE"],
  [503, "TOKEN_ENDPOINT_UNAVAILABLE"],
] as const
```

Add separate tests for 429 delta-seconds, 429 HTTP-date, invalid Retry-After, non-JSON 200, empty access token, empty refresh token, a refused local URL, 15-second timeout, caller abort, and a response containing Token/URL canaries. Assert every caught error serializes through `safeErrorDetails` to code only.

- [ ] **Step 5: Run focused GREEN and typecheck**

Run:

```powershell
volta run --node 22.23.1 npm exec -- vitest run tests/unit/openlist-token-service.test.ts tests/unit/errors.test.ts
volta run --node 22.23.1 npm run typecheck
```

Expected: all focused tests and typecheck pass; existing personal-OAuth code remains untouched in this additive task.

- [ ] **Step 6: Commit Task 1**

```powershell
git add -- src/errors.ts src/providers/aliyun/types.ts src/providers/aliyun/openlist-token-service.ts tests/helpers/fake-openlist-server.ts tests/unit/openlist-token-service.test.ts
git diff --cached --check
git commit -m "feat: add openlist token service client"
```

---

### Task 2: Atomically switch configuration and Vault records to OpenList

**Files:**

- Modify: `src/credentials/types.ts`
- Modify: `src/contracts.ts`
- Modify: `src/credentials/crypto.ts`
- Modify: `src/credentials/token-manager.ts`
- Modify: `src/providers/aliyun/provider.ts`
- Create: `src/providers/aliyun/constants.ts`
- Modify: `src/providers/aliyun/openlist-token-service.ts`
- Modify: `src/providers/aliyun/upload.ts`
- Modify: `src/runtime-composition.ts`
- Modify: `src/config.ts`
- Modify: `src/index.ts`
- Modify: `src/cli-entry.ts`
- Modify: `src/admin/setup-server.ts`
- Modify: `src/admin/status-route.ts`
- Modify: `ui/setup.html`
- Modify: `ui/setup.js`
- Modify: `ui/setup.css`
- Modify: `openclaw.plugin.json`
- Remove: `src/providers/aliyun/http.ts`
- Test: `tests/unit/credential-crypto.test.ts`
- Test: `tests/unit/credential-store.test.ts`
- Test: `tests/unit/config.test.ts`
- Test: `tests/unit/token-manager.test.ts`
- Test: `tests/unit/aliyun-provider.test.ts`
- Test: `tests/unit/aliyun-upload.test.ts` (v2 fixture and constructor cutover only)
- Test: `tests/unit/orchestrator.test.ts` (v2 fixture and constructor cutover only)
- Test: `tests/integration/admin-server.test.ts`
- Test: `tests/integration/leakage.test.ts` (v2 fixture and constructor cutover only)
- Test: `tests/integration/plugin-entry.test.ts`

**Interfaces:**

- Consumes: `AliyunTokenService.refresh`, current CredentialStore CAS, current account masking and setup-server security controls.
- Produces:

```ts
export type RefreshState = {
  status: "ready" | "degraded" | "rate_limited" | "reauth_required";
  notBefore?: string;
  failureCode?:
    | "TOKEN_ENDPOINT_UNAVAILABLE"
    | "RATE_LIMITED"
    | "REFRESH_TOKEN_REJECTED";
};

export type CredentialRecord = {
  formatVersion: 2;
  credentialVersion: number;
  authorizationPageUrl: string;
  refreshApiUrl: string;
  refreshToken: string;
  accessToken: string;
  account: {
    userIdMasked: string;
    displayNameMasked?: string;
  };
  lastVerifiedAt: string;
  refreshState: RefreshState;
};

export type CredentialInput = {
  authorizationPageUrl: string;
  refreshApiUrl: string;
  refreshToken: string;
  credentialVersion?: number;
};
```

- `PluginConfig` becomes exactly `{ defaultDirectory: string }`.
- `TokenManager` receives `{ store, tokenService, clock? }` as an options object in this task. Task 4 adds the refresh lease.

- [ ] **Step 1: Replace fixtures first and prove the old implementation fails**

Update every record builder and TokenManager construction in `credential-crypto`, `credential-store`, `token-manager`, `aliyun-provider`, `aliyun-upload`, `orchestrator`, `admin-server`, `plugin-entry`, and `leakage` tests to emit `formatVersion: 2`, both URLs, both Tokens, masked account, `lastVerifiedAt`, and `{ status: "ready" }`. This step only updates fixtures in tests whose new behavior belongs to Tasks 3 or 5. Change setup payload expectations to:

```ts
{
  authorizationPageUrl: "http://auth.example.test/custom",
  refreshApiUrl: `${openList.baseUrl}/custom/renew`,
  refreshToken: "refresh-candidate",
}
```

Change the setup HTML/browser assertions to require `authorizationPageUrl`, `refreshApiUrl`, and `refreshToken`, and to assert that `clientId`, `clientSecret`, and `accessToken` elements do not exist.

- [ ] **Step 2: Run the cutover test set and verify RED**

Run:

```powershell
volta run --node 22.23.1 npm exec -- vitest run tests/unit/credential-crypto.test.ts tests/unit/credential-store.test.ts tests/unit/config.test.ts tests/unit/token-manager.test.ts tests/unit/aliyun-provider.test.ts tests/unit/aliyun-upload.test.ts tests/unit/orchestrator.test.ts tests/integration/admin-server.test.ts tests/integration/plugin-entry.test.ts tests/integration/leakage.test.ts
```

Expected: FAIL on version 1 fields, legacy setup form fields, direct Aliyun refresh calls, and missing default OpenList URLs.

- [ ] **Step 3: Replace the credential record and encryption generation**

Replace `CredentialRecord` and `CredentialInput` with the interfaces above. Change the credential crypto AAD to:

```ts
const AAD = Buffer.from("openclaw-pan-sync-helper:credentials:v2", "utf8");
```

Do not add an AAD fallback or a version-1 union. Update store/crypto tests so a v2 round trip succeeds, ciphertext contains none of the refresh/access/URL canaries, and a v1-AAD envelope is rejected.

- [ ] **Step 4: Cut Provider validation to OpenList**

Replace `AliyunProviderOptions.httpClient` with `tokenService: AliyunTokenService`. Validate all three candidate strings as non-empty and within the existing 4096-character setup field limit. Call:

```ts
const refreshed = await this.options.tokenService.refresh({
  refreshApiUrl: candidate.refreshApiUrl,
  refreshToken: candidate.refreshToken,
  ...(options.signal === undefined ? {} : { signal: options.signal }),
});
```

Then call `/adrive/v1.0/user/getDriveInfo` with the existing `retryUnauthorized: false` option, mask the account, and return a v2 record with the candidate authorization/refresh URLs, rotated Tokens, `lastVerifiedAt`, and `refreshState: { status: "ready" }`. Task 3 renames that option when it replaces generic-401 behavior with exact Token-error behavior.

Preserve `TOKEN_ENDPOINT_UNAVAILABLE`, `RATE_LIMITED`, and `REFRESH_TOKEN_REJECTED`; do not collapse them into `CREDENTIALS_INVALID`.

- [ ] **Step 5: Make TokenManager v2-reactive without cooldown yet**

Remove `REFRESH_WINDOW_MS` and every access-token expiry comparison. `getValidAccessToken()` returns a non-empty access token for ready records and throws the persisted failure code for non-ready records. `forceRefresh(expectedAccessToken)` continues to short-circuit if another writer already changed the access token, otherwise calls `tokenService.refresh`, CAS-saves both Tokens with `refreshState: { status: "ready" }`, and returns the winning access token on a CAS loss.

Task 4 will add durable failure writes and the cross-process refresh lease; this task must retain process-local single-flight and cancellation behavior.

- [ ] **Step 6: Replace the setup-server request and projection**

Use these defaults when no record exists:

```ts
{
  configured: false,
  credentials: {
    authorizationPageUrl: DEFAULT_OPENLIST_AUTHORIZATION_PAGE_URL,
    refreshApiUrl: DEFAULT_OPENLIST_REFRESH_API_URL,
    refreshToken: "",
  },
  defaultDirectory,
}
```

For configured records, return the full refresh token and both full URLs, but never return `accessToken` or `refreshState.failureCode`. `PUT /api/config` accepts exactly the three new fields. Its parser applies the existing 4096-character maximum, requires non-empty strings, and calls `new URL(...)` for both URL fields without imposing any protocol, host, IP, port, user-info, or network-range policy. `POST /api/revalidate` validates the saved three fields and performs one OpenList call. Preserve authorization generations, body limits, aborts, CAS conflict handling, and old-record retention on failure.

- [ ] **Step 7: Replace the setup page fields and warning**

Use these element IDs:

```html
<input id="authorizationPageUrl" name="authorizationPageUrl" type="text" required>
<a id="openAuthorizationPage" target="_blank" rel="noreferrer noopener">Open OpenList authorization</a>
<input id="refreshApiUrl" name="refreshApiUrl" type="text" required>
<input id="refreshToken" name="refreshToken" type="text" autocomplete="off" required>
```

The visible warning must state that the refresh token is sent to the configured refresh API URL and that HTTP/self-hosted/third-party service risk belongs to the user. Update `setup.js` to bind the link to the current authorization input, post exactly the three fields, fully re-display them from authenticated config responses, and clear them on pagehide. Do not place an access token in DOM state.

- [ ] **Step 8: Remove ordinary token-guide configuration and wire runtime**

Make `resolvePluginConfig` accept only `defaultDirectory`. Remove `tokenGuideUrl` from `src/index.ts`, `src/cli-entry.ts`, and both manifest schemas. Instantiate one `OpenListTokenService`, pass it to Provider and TokenManager, and expose it as `tokenService` rather than `httpClient` from `PanSyncRuntime`.

Create `src/providers/aliyun/constants.ts` with:

```ts
export const ALIYUN_OPENAPI_BASE_URL = "https://openapi.alipan.com";
```

Move the two default OpenList URL constants from the Task 1 module into this constants file and update `openlist-token-service.ts`, `provider.ts`, `upload.ts`, and `setup-server.ts` to import them from there. Delete `src/providers/aliyun/http.ts` after `rg "AliyunHttpClient|oauth/access_token|tokenGuideUrl" src ui openclaw.plugin.json` has no live consumer.

- [ ] **Step 9: Update Control UI projection**

Add `rate_limited` to bounded statuses. Remove Client ID rendering and add:

```html
<dt>Token service</dt><dd>OpenList</dd>
```

Assert the page contains no configured authorization URL, refresh URL, refresh token, access token, `client_id`, or `client_secret`.

- [ ] **Step 10: Run the cutover gate**

Run:

```powershell
volta run --node 22.23.1 npm run test:unit
volta run --node 22.23.1 npm exec -- vitest run tests/integration/admin-server.test.ts tests/integration/plugin-entry.test.ts tests/integration/leakage.test.ts
volta run --node 22.23.1 npm run typecheck
rg -n "clientId|clientSecret|accessTokenExpiresAt|tokenGuideUrl|oauth/access_token" src ui openclaw.plugin.json
```

Expected: focused tests and typecheck pass. The final `rg` returns no live production matches; test canaries may remain outside the searched paths only when asserting absence.

- [ ] **Step 11: Commit Task 2**

```powershell
git add -- src/credentials/types.ts src/contracts.ts src/credentials/crypto.ts src/credentials/token-manager.ts src/providers/aliyun/provider.ts src/providers/aliyun/constants.ts src/providers/aliyun/upload.ts src/providers/aliyun/openlist-token-service.ts src/providers/aliyun/http.ts src/runtime-composition.ts src/config.ts src/index.ts src/cli-entry.ts src/admin/setup-server.ts src/admin/status-route.ts ui/setup.html ui/setup.js ui/setup.css openclaw.plugin.json tests/unit/credential-crypto.test.ts tests/unit/credential-store.test.ts tests/unit/config.test.ts tests/unit/token-manager.test.ts tests/unit/aliyun-provider.test.ts tests/unit/aliyun-upload.test.ts tests/unit/orchestrator.test.ts tests/integration/admin-server.test.ts tests/integration/plugin-entry.test.ts tests/integration/leakage.test.ts
git diff --cached --check
git commit -m "feat: switch aliyun credentials to openlist"
```

---

### Task 3: Refresh only on explicit Aliyun Token failures

**Files:**

- Modify: `src/providers/aliyun/upload.ts`
- Modify: `src/providers/aliyun/provider.ts`
- Test: `tests/unit/aliyun-upload.test.ts`
- Test: `tests/unit/aliyun-provider.test.ts`
- Test: `tests/unit/orchestrator.test.ts`

**Interfaces:**

- Consumes: `TokenManager.forceRefresh(expectedAccessToken, options)`.
- Produces: `AliyunAuthorizedClient.post` option `retryTokenFailure?: boolean` and exact Token-failure recognition.

- [ ] **Step 1: Write failing explicit-error tests**

Use table-driven cases for response bodies:

```ts
[
  [401, { code: "AccessTokenInvalid" }],
  [401, { code: "AccessTokenExpired" }],
  [400, { code: "I400JD" }],
] as const
```

Each case must assert one `forceRefresh`, one retry, and success with the returned access token. Add negative cases for generic 401 with an empty body, 401 business errors, 403, 429, 500, and network failure; each must assert zero refresh calls.

- [ ] **Step 2: Run focused tests and verify RED**

```powershell
volta run --node 22.23.1 npm exec -- vitest run tests/unit/aliyun-upload.test.ts tests/unit/aliyun-provider.test.ts
```

Expected: generic 401 currently refreshes, and non-401 explicit Token codes do not.

- [ ] **Step 3: Implement exact normalized-code recognition**

Normalize only `body.code ?? body.error` to lower-case ASCII and accept exactly:

```ts
const ACCESS_TOKEN_FAILURE_CODES = new Set([
  "accesstokeninvalid",
  "accesstokenexpired",
  "i400jd",
]);
```

Do not use substring matching. Refresh only when the normalized code is in this set, `retryTokenFailure !== false`, and the request has not already been retried. After refreshing, retry the same request once. If the retry returns a Token failure, throw `AUTHORIZATION_REVOKED` without another refresh.

- [ ] **Step 4: Prove concurrent multipart and multi-file paths share the winning Token**

Add one multipart case where an API request receives `AccessTokenExpired` while part PUTs remain direct signed-URL operations, and one orchestrator case with multiple files racing after the same stale Token. Assert the TokenManager mock is invoked once and every retried Aliyun API request uses the same new Bearer token.

- [ ] **Step 5: Run GREEN tests and commit**

```powershell
volta run --node 22.23.1 npm exec -- vitest run tests/unit/aliyun-upload.test.ts tests/unit/aliyun-provider.test.ts tests/unit/orchestrator.test.ts
git add -- src/providers/aliyun/upload.ts src/providers/aliyun/provider.ts tests/unit/aliyun-upload.test.ts tests/unit/aliyun-provider.test.ts tests/unit/orchestrator.test.ts
git diff --cached --check
git commit -m "fix: refresh only expired aliyun access tokens"
```

---

### Task 4: Persist cooldown and serialize refreshes across processes

**Files:**

- Modify: `src/credentials/token-manager.ts`
- Modify: `src/runtime-composition.ts`
- Create: `tests/helpers/token-refresh-child.mjs`
- Create: `tests/integration/token-refresh-process.test.ts`
- Test: `tests/unit/token-manager.test.ts`
- Test: `tests/integration/plugin-entry.test.ts`

**Interfaces:**

- Consumes: `CredentialLeaseRunner`, `AliyunTokenService`, v2 `refreshState`, `PanSyncError.retryAfterMs`.
- Produces:

```ts
export type TokenManagerStatus =
  | "unconfigured"
  | "ready"
  | "degraded"
  | "rate_limited"
  | "reauth_required";

export type TokenManagerOptions = {
  store: TokenCredentialVault;
  tokenService: AliyunTokenService;
  runWithRefreshLease: CredentialLeaseRunner;
  clock?: () => number;
};
```

- [ ] **Step 1: Add failing durable-state tests**

Use a fixed clock and assert exact candidate state:

```ts
expect(current().refreshState).toEqual({
  status: "rate_limited",
  notBefore: "2026-07-31T13:00:00.000Z",
  failureCode: "RATE_LIMITED",
});
```

Cover 429 with a service-provided delay, 429 without metadata using 60 minutes, network/timeout/5xx using one minute, rejected Token using `reauth_required` without `notBefore`, success clearing failure state, and cancellation making no Vault mutation.

- [ ] **Step 2: Prove cooldown blocks upstream calls before implementation**

Construct a fresh TokenManager from a persisted degraded/rate-limited/reauth record and call `forceRefresh`. Assert the fake service receives zero requests and the stable error code matches the stored failure. Advance the fixed clock to exactly `notBefore` and assert one call becomes eligible.

Run:

```powershell
volta run --node 22.23.1 npm exec -- vitest run tests/unit/token-manager.test.ts
```

Expected: FAIL because failures are not yet persisted and constructor refresh leases are absent.

- [ ] **Step 3: Persist success and failure with CAS**

Inside the existing process-local single-flight, acquire a dedicated lease key `aliyun-token-refresh`. After lease acquisition, reread the Vault and repeat all expected-token/cooldown checks. Only the lease holder may call OpenList.

On failure, CAS-write a record with `credentialVersion + 1`, unchanged Tokens/URLs/account, and the mapped refresh state. On success, CAS-write both returned Tokens and `{ status: "ready" }`. If CAS loses, reread the winner: return its non-empty access token when ready, or throw its persisted failure code.

Use valid `retryAfterMs` from the error; otherwise apply constants:

```ts
const RATE_LIMIT_FALLBACK_MS = 60 * 60 * 1_000;
const TRANSIENT_FAILURE_COOLDOWN_MS = 60 * 1_000;
```

- [ ] **Step 4: Wire the shared SQLite lease runner**

In `createPanSyncRuntime`, create the lease runner once and pass the same function to CredentialStore and TokenManager. Do not create a second database or an in-memory production lock.

- [ ] **Step 5: Add the cross-process integration harness**

Compile production TypeScript to a temporary directory as the existing SQLite process test does. Initialize one shared v2 Vault and one fake OpenList server whose first response is delayed until both children have started. Each child imports the compiled CredentialStore, SQLite lease runner, OpenListTokenService, and TokenManager, then calls `forceRefresh("access-stale")` and reports its result over IPC.

Assert:

```ts
expect(openList.requests).toHaveLength(1);
expect(childResults).toEqual(["access-rotated", "access-rotated"]);
expect((await store.read())?.refreshToken).toBe("refresh-rotated");
```

Add a second case where process one persists 429 and process two receives `RATE_LIMITED` without a second upstream request.

- [ ] **Step 6: Run unit, process, and integration GREEN**

```powershell
volta run --node 22.23.1 npm exec -- vitest run tests/unit/token-manager.test.ts tests/integration/token-refresh-process.test.ts tests/integration/plugin-entry.test.ts
volta run --node 22.23.1 npm run typecheck
```

Expected: all pass, with one OpenList request in both multi-process cases.

- [ ] **Step 7: Commit Task 4**

```powershell
git add -- src/credentials/token-manager.ts src/runtime-composition.ts tests/helpers/token-refresh-child.mjs tests/integration/token-refresh-process.test.ts tests/unit/token-manager.test.ts tests/integration/plugin-entry.test.ts
git diff --cached --check
git commit -m "feat: persist openlist refresh cooldown"
```

---

### Task 5: Complete leakage, package, and user-documentation gates

**Files:**

- Modify: `tests/integration/leakage.test.ts`
- Modify: `tests/integration/package.test.ts`
- Modify: `tests/integration/tool.test.ts`
- Modify: `README.md`
- Modify: `docs/guides/aliyun-token.md`
- Modify: `docs/plans/token-acquisition-web-system.md`

**Interfaces:**

- Consumes: completed OpenList runtime, setup API, and five public statuses.
- Produces: current user journey and regression gates with no custom-app guidance.

- [ ] **Step 1: Write failing leakage and package assertions**

Use distinct canaries for refresh token, access token, authorization URL, refresh API URL, OpenList error text, and absolute workspace path. Exercise setup failure, runtime 429, runtime 5xx, invalid Token, status route, Tool response, and logger boundary. Authenticated setup `GET /api/config` may contain the refresh token and both URLs; every other surface must contain none of them.

Add package assertions that no source, tests, Vault files, custom URL canaries, or `client_secret` guidance ships. Keep `skills/pan-sync-upload/SKILL.md`, setup assets, README, manifest, CLI metadata, and built runtime required.

- [ ] **Step 2: Run the integration tests and verify RED**

```powershell
volta run --node 22.23.1 npm exec -- vitest run tests/integration/leakage.test.ts tests/integration/package.test.ts tests/integration/tool.test.ts
```

Expected: FAIL on legacy custom-client documentation/fixtures or missing OpenList-specific leakage cases.

- [ ] **Step 3: Rewrite the current README journey**

Document exactly:

1. Install and enable the plugin.
2. Run `openclaw pan-sync configure` on the host.
3. Use the default China OpenList page or edit the authorization page URL.
4. Select Aliyun Drive App Login, scan, and copy the refresh token.
5. Paste it, review/edit the complete refresh API URL, and save.
6. Explain that the first save calls OpenList once, later refresh is only after an explicit Aliyun access-token failure, and files upload directly to Aliyun.
7. Explain custom HTTP/third-party URL risk and that the plugin does not fall back to another service.
8. Explain reauthorization, rate-limited, degraded, and ready states.

Remove every instruction to register an Aliyun app or enter Client ID/Secret.

- [ ] **Step 4: Replace the Token guide and supersede the old external-system plan**

Make `docs/guides/aliyun-token.md` the detailed OpenList authorization guide with the two default China URLs, global/custom replacement explanation, manual paste, full re-display warning, and revocation/re-auth steps.

At the top of `docs/plans/token-acquisition-web-system.md`, mark the plan superseded by `docs/superpowers/specs/2026-08-01-openlist-token-service-design.md` and state that no separate Token web system is planned for this plugin version. Do not leave it presented as active work.

- [ ] **Step 5: Run documentation and packaging GREEN**

```powershell
volta run --node 22.23.1 npm exec -- vitest run tests/integration/leakage.test.ts tests/integration/package.test.ts tests/integration/tool.test.ts
volta run --node 22.23.1 npm run build
volta run --node 22.23.1 npm pack --dry-run
rg -n "client.?id|client.?secret|oauth/access_token|AList public|自定义客户端" README.md docs/guides/aliyun-token.md ui src openclaw.plugin.json -i
git diff --check
```

Expected: tests/build/package pass. The final search returns no user instruction or production path for personal OAuth credentials; historical superseded design files are outside the search scope.

- [ ] **Step 6: Commit Task 5**

```powershell
git add -- README.md docs/guides/aliyun-token.md docs/plans/token-acquisition-web-system.md tests/integration/leakage.test.ts tests/integration/package.test.ts tests/integration/tool.test.ts
git diff --cached --check
git commit -m "docs: document openlist authorization flow"
```

---

### Task 6: Run complete verification and record independent acceptance gates

**Files:**

- Create: `docs/verification/2026-08-01-openlist-token-service.md`
- Modify only if a verified defect is found: the smallest source/test files responsible for that defect

**Interfaces:**

- Consumes: installable package, official OpenClaw CLI, setup page, fake and real OpenList/Aliyun services.
- Produces: an evidence-backed PASS/FAIL/NOT RUN report and release verdict.

- [ ] **Step 1: Run the complete automated gate from a clean tracked tree**

```powershell
volta run --node 22.23.1 npm ci --no-audit --no-fund
volta run --node 22.23.1 npm run verify
git diff --check
git status --short
```

Record exact test-file/test counts, the one intentional platform skip if still present, build result, npm pack file count, and tarball SHA-256. Do not stage generated `dist/` or `node_modules/`.

- [ ] **Step 2: Install the packed artifact into a private OpenClaw test root**

Use the official installed `openclaw` CLI with a temporary private state/config root. Install and enable the packed artifact, then prove:

- plugin discovery has no manifest diagnostics;
- `pan_sync_upload` is registered;
- `openclaw pan-sync configure` launches a loopback-only setup server;
- the read-only Control UI contains `Token service: OpenList` and no sensitive fields.

Never record the one-time fragment key, dynamic port, Token, raw config, or absolute temporary root in the report.

- [ ] **Step 3: Perform browser acceptance of the installed package**

Use the browser-control skill at execution time. Verify the actual installed setup page has exactly the two URL fields and refresh-token field, defaults to the China URLs, updates the authorization link when edited, fully re-displays saved values, removes Client ID/Secret/Access Token inputs, preserves the fragment/session reload behavior, and clears secrets on pagehide.

Use fake local OpenList/Aliyun endpoints for repeatable browser tests. Sanitize screenshots and reports.

- [ ] **Step 4: Run real-service acceptance only with user-provided authorization**

If a real Aliyun account and permission to use OpenList are available:

1. Obtain a refresh token from the official China authorization page.
2. Save through the installed setup page.
3. Upload a uniquely named harmless file to `/openClawShare`.
4. Confirm the remote file name and size.
5. Confirm a second operation with the valid access token makes no OpenList refresh request.
6. Exercise an explicit access-token-expired condition only if it can be done without revoking or risking the account; otherwise mark this sub-gate NOT RUN and rely on the deterministic integration gate.

Do not place real Tokens, account identifiers, IPs, URLs with query values, or remote file IDs in evidence.

- [ ] **Step 5: Write the verification report**

Use separate sections:

```markdown
## Automated gate
## OpenClaw installed-package smoke
## Browser acceptance
## Real OpenList/Aliyun account acceptance
## Package contents
## Security and leakage
## Remaining blockers
## Release verdict
```

Mark each section `PASS`, `FAIL`, or `NOT RUN`. Automated success must not convert missing real-account evidence into PASS. If the real account or installed-package smoke is unavailable, the release verdict remains BLOCKED.

- [ ] **Step 6: Fix only verified defects with a new RED/GREEN cycle**

For any failure, invoke `superpowers:systematic-debugging`, add the smallest reproducing test, prove RED, implement the minimal fix, rerun the focused test and full `npm run verify`, and request a fresh review. Do not alter unrelated upload behavior to make acceptance pass.

- [ ] **Step 7: Commit the verification report**

```powershell
git add -- docs/verification/2026-08-01-openlist-token-service.md
git diff --cached --check
git commit -m "docs: record openlist token service verification"
```

Do not commit Tokens, temporary state, screenshots containing live material, `dist/`, `node_modules/`, or the packed tarball.

---

## Final Review and Handoff

- Request a whole-branch review against `docs/superpowers/specs/2026-08-01-openlist-token-service-design.md` after Tasks 1-6.
- Resolve every Critical or Important finding with a reproducing test and a new review.
- Run a fresh `volta run --node 22.23.1 npm run verify` after the final fix.
- Report separately: implementation status, automated gate, installed OpenClaw smoke, browser acceptance, real OpenList/Aliyun acceptance, package gate, and release verdict.
- Do not merge, push, publish, or create a PR unless the user separately requests it.
