# OpenClaw Pan Sync Helper Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付一个可安装的 OpenClaw TypeScript ESM 插件，让 Agent 将当前工作区内的一个或多个普通文件上传到单一阿里云盘账号，并提供安全、可完整回显凭证的一次性配置页面。

**Architecture:** 插件入口只负责装配 Tool、Skill、只读 Control UI、CLI 和服务生命周期。上传业务经过 `UploadOrchestrator -> ProviderRegistry -> AliyunProvider`；凭证由 AES-256-GCM Vault 持久化，并使用 Node 22 内置 SQLite 的 Worker 事务租约协调 Gateway 与 CLI 两个进程。`openclaw pan-sync configure` 仅在 `127.0.0.1` 启动短时配置页，Control UI iframe 不承担敏感写入。

**Tech Stack:** Node.js 22.22.3+、TypeScript ESM、OpenClaw Plugin SDK `>=2026.7.1-2`、`typebox`、原生 `fetch`/`node:http`/`node:crypto`/`node:fs`/`node:sqlite`/`node:worker_threads`、Vitest。

## Global Constraints

- 第一版只允许一个阿里云盘账号；Provider 抽象必须保留，但不得实现第二个网盘。
- 插件不实现二维码登录、OAuth 回调、公共 Token 中转或刷新服务。
- 初始 `refresh_token` 必须由用户使用自己注册的 `client_id`、`client_secret` 从 AList 等第三方工具取得。
- 插件后续直接调用 `https://openapi.alipan.com/oauth/access_token` 刷新并轮换 Token，不依赖 AList 运行时。
- 默认 Provider 为 `aliyun`，别名固定为 `阿里网盘`、`阿里云盘`、`aliyun`、`alipan`。
- 默认远端目录为 `/openClawShare`；同名文件使用 `auto_rename`，不覆盖。
- Agent Tool 只接收当前 OpenClaw 工作区内的普通文件；拒绝目录、特殊文件、`..`、绝对路径逃逸和符号链接逃逸。
- `client_secret` 与 `refresh_token` 仅在短时回环地址配置页完整回显；Control UI、Tool 结果、日志和错误中只能出现脱敏状态。
- 配置页必须绑定 `127.0.0.1`，远程访问必须经 SSH 端口转发；不得增加 `0.0.0.0` 监听选项。
- 一次性页面访问密钥使用 URL fragment 传递，立即移入 `sessionStorage` 并从地址栏删除；不得进入请求 URL、日志或 Referer。
- 凭证目录权限为 `0700`，`master.key` 和 `credentials.enc` 为 `0600`；写入必须临时文件、`fsync`、原子替换。
- Gateway 与 CLI 对凭证的读改写必须使用同一个 OpenClaw state lease；刷新使用 single-flight，401 最多刷新并重试一次。
- 所有上游错误必须映射到稳定错误码；禁止向 Agent 返回 Token、完整绝对路径、原始响应体或调用栈。
- 自动化测试、真实账号验收、发布包检查是三个独立门槛；没有真实账号证据时不得声称真实上传已验证。
- 实现阶段每个任务都遵循 `superpowers:test-driven-development`；完成声明前遵循 `superpowers:verification-before-completion`。

---

## File Map

实现完成后的主要文件如下：

```text
.
├── package.json
├── package-lock.json
├── tsconfig.json
├── tsconfig.build.json
├── vitest.config.ts
├── openclaw.plugin.json
├── scripts/
│   └── copy-assets.mjs
├── src/
│   ├── index.ts
│   ├── config.ts
│   ├── contracts.ts
│   ├── errors.ts
│   ├── provider-registry.ts
│   ├── tool.ts
│   ├── credentials/
│   │   ├── crypto.ts
│   │   ├── store.ts
│   │   ├── token-manager.ts
│   │   └── types.ts
│   ├── workspace/
│   │   └── path-guard.ts
│   ├── upload/
│   │   └── orchestrator.ts
│   ├── providers/
│   │   └── aliyun/
│   │       ├── http.ts
│   │       ├── provider.ts
│   │       ├── types.ts
│   │       └── upload.ts
│   └── admin/
│       ├── cli.ts
│       ├── setup-page.ts
│       ├── setup-server.ts
│       └── status-route.ts
├── ui/
│   ├── setup.html
│   ├── setup.js
│   └── setup.css
├── skills/
│   └── pan-sync-upload/
│       └── SKILL.md
├── tests/
│   ├── helpers/
│   │   ├── fake-aliyun-server.ts
│   │   └── temp-state.ts
│   ├── unit/
│   │   ├── config.test.ts
│   │   ├── errors.test.ts
│   │   ├── provider-registry.test.ts
│   │   ├── credential-crypto.test.ts
│   │   ├── credential-store.test.ts
│   │   ├── token-manager.test.ts
│   │   ├── path-guard.test.ts
│   │   ├── aliyun-provider.test.ts
│   │   ├── aliyun-upload.test.ts
│   │   └── orchestrator.test.ts
│   └── integration/
│       ├── admin-cli.test.ts
│       ├── admin-server.test.ts
│       ├── plugin-entry.test.ts
│       └── tool.test.ts
├── docs/
│   ├── guides/
│   │   └── aliyun-token.md
│   └── plans/
│       └── token-acquisition-web-system.md
└── README.md
```

## Task 1: Scaffold the installable plugin package

**Files:**

- Create: `package.json`
- Create: `tsconfig.json`
- Create: `tsconfig.build.json`
- Create: `vitest.config.ts`
- Create: `openclaw.plugin.json`
- Create: `scripts/copy-assets.mjs`
- Create: `src/config.ts`
- Test: `tests/unit/config.test.ts`

- [ ] **Step 1: Write the failing configuration contract test**

```ts
import { describe, expect, it } from "vitest";
import { resolvePluginConfig } from "../../src/config.js";

describe("resolvePluginConfig", () => {
  it("uses the v1 defaults", () => {
    expect(resolvePluginConfig(undefined)).toEqual({
      defaultDirectory: "/openClawShare",
      tokenGuideUrl: undefined,
    });
  });

  it("rejects credentials in ordinary plugin config", () => {
    expect(() => resolvePluginConfig({ refreshToken: "must-not-live-here" })).toThrow(
      "unknown configuration key",
    );
  });
});
```

- [ ] **Step 2: Run the focused test and confirm the expected failure**

Run: `npm test -- --run tests/unit/config.test.ts`

Expected: FAIL because `package.json` and `src/config.ts` do not exist.

- [ ] **Step 3: Create package metadata and build scripts**

Use these package invariants:

```json
{
  "name": "openclaw-pan-sync-helper",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.js",
  "exports": {
    ".": "./dist/index.js"
  },
  "files": [
    "dist",
    "ui",
    "skills",
    "openclaw.plugin.json",
    "README.md"
  ],
  "engines": {
    "node": ">=22.22.3"
  },
  "peerDependencies": {
    "openclaw": ">=2026.7.1-2"
  },
  "dependencies": {
    "typebox": "^1.1.39"
  },
  "devDependencies": {
    "@types/node": "^24.0.0",
    "openclaw": "2026.7.1-2",
    "typescript": "^5.9.0",
    "vitest": "^3.2.0"
  },
  "scripts": {
    "build": "tsc -p tsconfig.build.json && node scripts/copy-assets.mjs",
    "test": "vitest",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "verify": "npm run typecheck && npm test -- --run && npm run build && npm pack --dry-run"
  }
}
```

The manifest must declare:

```json
{
  "id": "pan-sync-helper",
  "name": "Pan Sync Helper",
  "description": "Upload OpenClaw workspace files to a configured cloud drive",
  "version": "0.1.0",
  "skills": ["skills/pan-sync-upload"],
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "defaultDirectory": {
        "type": "string",
        "default": "/openClawShare"
      },
      "tokenGuideUrl": {
        "type": "string",
        "format": "uri"
      }
    }
  }
}
```

`tsconfig.json` must use `module`/`moduleResolution: "NodeNext"`, `target: "ES2022"`, `strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`, `verbatimModuleSyntax: true`, and include both `src/**/*.ts` and `tests/**/*.ts`.

`tsconfig.build.json` must extend the base config, set `rootDir: "src"`, `outDir: "dist"`, emit declarations and source maps, and include only `src/**/*.ts`.

`vitest.config.ts` must use the Node environment, restore and clear mocks between tests, and set a 15-second default timeout. Network-facing tests must inject the local fake server; the test suite must never contact Aliyun or AList.

- [ ] **Step 4: Implement strict non-secret configuration parsing**

```ts
export type PluginConfig = {
  defaultDirectory: string;
  tokenGuideUrl?: string;
};

const ALLOWED_KEYS = new Set(["defaultDirectory", "tokenGuideUrl"]);

export function resolvePluginConfig(value: unknown): PluginConfig {
  const record =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  for (const key of Object.keys(record)) {
    if (!ALLOWED_KEYS.has(key)) {
      throw new Error(`unknown configuration key: ${key}`);
    }
  }
  const defaultDirectory =
    typeof record.defaultDirectory === "string"
      ? record.defaultDirectory.trim()
      : "/openClawShare";
  const tokenGuideUrl =
    typeof record.tokenGuideUrl === "string" && record.tokenGuideUrl.trim()
      ? new URL(record.tokenGuideUrl).toString()
      : undefined;
  return { defaultDirectory, tokenGuideUrl };
}
```

- [ ] **Step 5: Install dependencies and make the focused test pass**

Run: `npm install`

Run: `npm test -- --run tests/unit/config.test.ts`

Expected: PASS, 2 tests.

- [ ] **Step 6: Commit the scaffold**

```bash
git add package.json package-lock.json tsconfig.json tsconfig.build.json vitest.config.ts openclaw.plugin.json scripts/copy-assets.mjs src/config.ts tests/unit/config.test.ts
git commit -m "chore: scaffold pan sync helper plugin"
```

## Task 2: Define stable domain contracts, errors, and Provider registry

**Files:**

- Create: `src/contracts.ts`
- Create: `src/errors.ts`
- Create: `src/provider-registry.ts`
- Test: `tests/unit/errors.test.ts`
- Test: `tests/unit/provider-registry.test.ts`

- [ ] **Step 1: Write failing Provider alias tests**

```ts
import { describe, expect, it } from "vitest";
import { ProviderRegistry } from "../../src/provider-registry.js";

const aliyun = {
  id: "aliyun",
  aliases: ["阿里网盘", "阿里云盘", "aliyun", "alipan"],
} as const;

describe("ProviderRegistry", () => {
  it.each(["阿里网盘", "阿里云盘", "aliyun", "ALIPAN"])(
    "resolves %s to aliyun",
    (name) => {
      const registry = new ProviderRegistry([aliyun as never], "aliyun");
      expect(registry.resolve(name).id).toBe("aliyun");
    },
  );

  it("uses aliyun when provider is omitted", () => {
    const registry = new ProviderRegistry([aliyun as never], "aliyun");
    expect(registry.resolve(undefined).id).toBe("aliyun");
  });
});
```

- [ ] **Step 2: Write failing redaction and stable-code tests**

```ts
import { describe, expect, it } from "vitest";
import { PanSyncError, safeErrorDetails } from "../../src/errors.js";

describe("safeErrorDetails", () => {
  it("does not expose secrets or absolute paths", () => {
    const secret = "refresh-secret-value";
    const error = new Error(`request failed token=${secret} at /srv/openclaw/report.pdf`);
    expect(safeErrorDetails(error)).toEqual({ code: "UPLOAD_FAILED" });
    expect(JSON.stringify(safeErrorDetails(error))).not.toContain(secret);
    expect(JSON.stringify(safeErrorDetails(error))).not.toContain("/srv/openclaw");
  });

  it("keeps explicit stable errors", () => {
    expect(safeErrorDetails(new PanSyncError("QUOTA_EXCEEDED"))).toEqual({
      code: "QUOTA_EXCEEDED",
    });
  });
});
```

- [ ] **Step 3: Run both tests and confirm missing-module failures**

Run: `npm test -- --run tests/unit/provider-registry.test.ts tests/unit/errors.test.ts`

Expected: FAIL because the domain files do not exist.

- [ ] **Step 4: Implement the exact public contracts**

`src/contracts.ts` must export:

```ts
export type ProviderId = "aliyun";

export type PanSyncUploadInput = {
  paths: string[];
  provider?: ProviderId;
  remoteDirectory?: string;
};

export type FileUploadResult = {
  inputName: string;
  remoteName?: string;
  size?: number;
  status: "uploaded" | "failed";
  errorCode?: PanSyncErrorCode;
};

export type PanSyncUploadResult = {
  provider: ProviderId;
  remoteDirectory: string;
  status: "success" | "partial" | "failed";
  files: FileUploadResult[];
};

export interface CloudDriveProvider {
  readonly id: ProviderId;
  readonly aliases: readonly string[];
  validateCredentials(candidate: CredentialInput): Promise<ValidatedCredentialRecord>;
  ensureDirectory(remotePath: string, accessToken: string): Promise<RemoteDirectory>;
  uploadFile(input: ProviderUploadInput): Promise<ProviderUploadResult>;
}
```

Keep credential and upload supporting types in the same file until their owning modules are introduced; do not use `any`.

- [ ] **Step 5: Implement stable error codes and Provider resolution**

The exact v1 code union is:

```ts
export type PanSyncErrorCode =
  | "CREDENTIALS_REQUIRED"
  | "CREDENTIALS_INVALID"
  | "REFRESH_TOKEN_REJECTED"
  | "AUTHORIZATION_REVOKED"
  | "TOKEN_ENDPOINT_UNAVAILABLE"
  | "RATE_LIMITED"
  | "WORKSPACE_PATH_REJECTED"
  | "FILE_NOT_FOUND"
  | "FILE_NOT_READABLE"
  | "REMOTE_DIRECTORY_FAILED"
  | "QUOTA_EXCEEDED"
  | "UPLOAD_FAILED"
  | "UPLOAD_PARTIAL";
```

`ProviderRegistry` must normalize English aliases with `toLocaleLowerCase("en-US")`, preserve Chinese aliases, reject duplicate aliases at construction, and throw `CREDENTIALS_INVALID` for an unknown Provider without echoing the raw input.

- [ ] **Step 6: Run the focused tests**

Run: `npm test -- --run tests/unit/provider-registry.test.ts tests/unit/errors.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit the domain layer**

```bash
git add src/contracts.ts src/errors.ts src/provider-registry.ts tests/unit/errors.test.ts tests/unit/provider-registry.test.ts
git commit -m "feat: add provider contracts and safe errors"
```

## Task 3: Build the encrypted Credential Vault with cross-process leases

**Files:**

- Create: `src/credentials/types.ts`
- Create: `src/credentials/crypto.ts`
- Create: `src/credentials/store.ts`
- Create: `tests/helpers/temp-state.ts`
- Test: `tests/unit/credential-crypto.test.ts`
- Test: `tests/unit/credential-store.test.ts`

- [ ] **Step 1: Write failing AES-GCM round-trip and tamper tests**

```ts
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptRecord, encryptRecord } from "../../src/credentials/crypto.js";

describe("credential crypto", () => {
  it("round-trips a versioned record", () => {
    const key = randomBytes(32);
    const record = { formatVersion: 1, credentialVersion: 7, clientId: "client" };
    expect(decryptRecord(key, encryptRecord(key, record))).toEqual(record);
  });

  it("rejects modified ciphertext", () => {
    const key = randomBytes(32);
    const envelope = encryptRecord(key, { formatVersion: 1, credentialVersion: 1 });
    envelope.ciphertext = `${envelope.ciphertext.slice(0, -2)}AA`;
    expect(() => decryptRecord(key, envelope)).toThrow("credential ciphertext rejected");
  });
});
```

- [ ] **Step 2: Write failing store permission, CAS, and rollback tests**

The store test must prove:

```ts
expect(octalMode(dataDir)).toBe("700");
expect(octalMode(masterKeyPath)).toBe("600");
expect(octalMode(credentialsPath)).toBe("600");
await expect(store.replaceIfVersion(1, newer)).resolves.toBe(true);
await expect(store.replaceIfVersion(1, stale)).resolves.toBe(false);
expect(await store.read()).toEqual(newer);
```

Inject a file adapter whose `rename` fails once and assert the previous encrypted record still decrypts.

- [ ] **Step 3: Run the tests and confirm failure**

Run: `npm test -- --run tests/unit/credential-crypto.test.ts tests/unit/credential-store.test.ts`

Expected: FAIL because crypto and store implementations are absent.

- [ ] **Step 4: Implement the versioned encrypted envelope**

Use this envelope:

```ts
export type EncryptedEnvelopeV1 = {
  formatVersion: 1;
  algorithm: "aes-256-gcm";
  nonce: string;
  authTag: string;
  ciphertext: string;
};
```

Use a 32-byte master key, a new 12-byte nonce per write, Base64URL fields, and authenticated additional data exactly equal to `openclaw-pan-sync-helper:credentials:v1`.

- [ ] **Step 5: Implement the persisted credential record**

```ts
export type CredentialRecord = {
  formatVersion: 1;
  credentialVersion: number;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  accessToken: string;
  accessTokenExpiresAt: string;
  account: {
    userIdMasked: string;
    displayNameMasked?: string;
  };
  lastVerifiedAt: string;
};
```

The store API must be:

```ts
export interface CredentialLeaseRunner {
  <T>(key: string, run: () => Promise<T>): Promise<T>;
}

export class CredentialStore {
  read(): Promise<CredentialRecord | undefined>;
  replace(candidate: CredentialRecord): Promise<void>;
  replaceIfVersion(expected: number, candidate: CredentialRecord): Promise<boolean>;
  clear(): Promise<void>;
}
```

The plugin uses a self-owned cross-process SQLite transaction lease at `<dataDir>/locks/lease.sqlite` because the supported OpenClaw release restricts `state.withLease` to bundled/trusted-official plugins. A dedicated Worker owns a `node:sqlite` `DatabaseSync` connection and holds `BEGIN IMMEDIATE` for the callback lifetime. Acquisition uses 200ms SQLite busy slices, a 15_000ms overall monotonic deadline, and a `SharedArrayBuffer`/`Atomics` cancellation flag so native busy waits never block the Gateway event loop or defer cancellation for the full deadline. The parent requests termination on acquisition cancellation, treats Worker exit/error as lease loss, and releases with COMMIT/ROLLBACK plus connection close. Process death automatically releases SQLite locks, so the design must not implement PID, heartbeat, stale-file deletion, or manual path recovery. The lock directory and database must request `0700`/`0600` permissions. Important Vault mutation boundaries must assert the live Worker/transaction ownership signal. This preserves safe community-plugin installation without privileged runtime state APIs or native npm dependencies.

- [ ] **Step 6: Implement safe filesystem writes**

For every write:

1. Ensure the data directory with mode `0700`.
2. Create `master.key` with `flag: "wx"` and mode `0600`; if it exists, read exactly 32 bytes.
3. Write the encrypted JSON to a random file in the same directory with mode `0600`.
4. `fsync` the temporary file.
5. Rename it over `credentials.enc`.
6. Open and `fsync` the parent directory on Linux.
7. Never log plaintext or the envelope.

- [ ] **Step 7: Run the focused tests**

Run: `npm test -- --run tests/unit/credential-crypto.test.ts tests/unit/credential-store.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit the vault**

```bash
git add src/credentials tests/helpers/temp-state.ts tests/unit/credential-crypto.test.ts tests/unit/credential-store.test.ts
git commit -m "feat: add encrypted credential vault"
```

## Task 4: Implement direct Aliyun token refresh and Token Manager

**Files:**

- Create: `src/providers/aliyun/types.ts`
- Create: `src/providers/aliyun/http.ts`
- Create: `src/credentials/token-manager.ts`
- Create: `tests/helpers/fake-aliyun-server.ts`
- Test: `tests/unit/token-manager.test.ts`

- [ ] **Step 1: Write the failing direct-refresh request test**

The fake server must record a request to `POST /oauth/access_token` and the test must assert:

```ts
expect(recorded.body).toEqual({
  client_id: "client-id",
  client_secret: "client-secret",
  grant_type: "refresh_token",
  refresh_token: "refresh-1",
});
expect(result.refreshToken).toBe("refresh-2");
```

- [ ] **Step 2: Write failing single-flight and rotation tests**

Create 20 concurrent `getValidAccessToken()` calls against an expired record. Assert the fake server receives one refresh request, every caller receives `access-2`, and the store contains `refresh-2` with `credentialVersion + 1`.

- [ ] **Step 3: Write failing failure-state tests**

Cover these exact mappings:

```text
invalid_grant                  -> REFRESH_TOKEN_REJECTED, reauthRequired=true
HTTP 429                       -> RATE_LIMITED
timeout / HTTP 502 / HTTP 503  -> TOKEN_ENDPOINT_UNAVAILABLE
```

Also assert a failed refresh leaves the previous encrypted record unchanged.

- [ ] **Step 4: Run the focused test and confirm failure**

Run: `npm test -- --run tests/unit/token-manager.test.ts`

Expected: FAIL because `AliyunHttpClient` and `TokenManager` do not exist.

- [ ] **Step 5: Implement the Aliyun HTTP boundary**

`AliyunHttpClient` accepts an injectable `baseUrl`, `fetch`, and clock. Production defaults:

```ts
const ALIYUN_OPENAPI_BASE_URL = "https://openapi.alipan.com";
```

It must expose:

```ts
refreshToken(input: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  signal?: AbortSignal;
}): Promise<{
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
}>;
```

Use a 15-second timeout and never include the request body or response body in thrown messages.

- [ ] **Step 6: Implement Token Manager freshness and single-flight**

```ts
export class TokenManager {
  getValidAccessToken(): Promise<string>;
  forceRefresh(expectedAccessToken?: string): Promise<string>;
  status(): Promise<"unconfigured" | "ready" | "degraded" | "reauth_required">;
}
```

Rules:

- Re-read the Vault before each decision so CLI changes are visible to the Gateway process.
- Refresh when no access token exists or remaining lifetime is below five minutes.
- Keep one process-local `refreshInFlight` promise.
- Persist rotated `refresh_token` and new access expiry under `replaceIfVersion`.
- If CAS loses, re-read the winning record and return its access token.
- Network errors set in-memory `degraded`; `invalid_grant` sets `reauth_required`.
- Do not run periodic background refresh.

- [ ] **Step 7: Run the focused tests**

Run: `npm test -- --run tests/unit/token-manager.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit token refresh**

```bash
git add src/providers/aliyun/types.ts src/providers/aliyun/http.ts src/credentials/token-manager.ts tests/helpers/fake-aliyun-server.ts tests/unit/token-manager.test.ts
git commit -m "feat: refresh aliyun tokens directly"
```

## Task 5: Enforce workspace and remote-path boundaries

**Files:**

- Create: `src/workspace/path-guard.ts`
- Test: `tests/unit/path-guard.test.ts`

- [ ] **Step 1: Write failing local path boundary tests**

Create a temporary workspace with a regular file, nested file, directory, symlink to an outside file, broken symlink, and FIFO on Linux. Assert:

```ts
await expect(resolveWorkspaceFile(workspace, "report.pdf")).resolves.toMatchObject({
  inputName: "report.pdf",
});
await expect(resolveWorkspaceFile(workspace, "../secret.txt")).rejects.toMatchObject({
  code: "WORKSPACE_PATH_REJECTED",
});
await expect(resolveWorkspaceFile(workspace, "escape-link")).rejects.toMatchObject({
  code: "WORKSPACE_PATH_REJECTED",
});
await expect(resolveWorkspaceFile(workspace, "folder")).rejects.toMatchObject({
  code: "WORKSPACE_PATH_REJECTED",
});
```

- [ ] **Step 2: Write failing remote directory normalization tests**

```ts
expect(normalizeRemoteDirectory("openClawShare/reports")).toBe("/openClawShare/reports");
expect(() => normalizeRemoteDirectory("/../../root")).toThrow("REMOTE_DIRECTORY_FAILED");
expect(() => normalizeRemoteDirectory("/bad\u0000name")).toThrow("REMOTE_DIRECTORY_FAILED");
```

- [ ] **Step 3: Run the tests and confirm failure**

Run: `npm test -- --run tests/unit/path-guard.test.ts`

Expected: FAIL because the guard is absent.

- [ ] **Step 4: Implement race-aware local validation**

`resolveWorkspaceFile` must:

1. Resolve and `realpath` the workspace root.
2. Resolve relative inputs under that root; absolute inputs are allowed only when their real path stays inside the root.
3. Reject lexical `..` escape before filesystem access.
4. `realpath` the candidate and compare with `path.relative`.
5. Open the file read-only, then `fstat` the open descriptor and require `isFile()`.
6. Return an object containing the open `FileHandle`, size, basename, and safe input name.
7. Require the caller to close the handle in `finally`.

Provider upload must stream from this already-open descriptor, not reopen the path by name.

- [ ] **Step 5: Implement POSIX remote directory normalization**

Use `path.posix`, force exactly one leading slash, reject NUL/control characters, remove `.` segments, and reject any `..` segment before normalization.

- [ ] **Step 6: Run the focused tests**

Run: `npm test -- --run tests/unit/path-guard.test.ts`

Expected: PASS on Windows; FIFO case conditionally runs on Linux.

- [ ] **Step 7: Commit path safety**

```bash
git add src/workspace/path-guard.ts tests/unit/path-guard.test.ts
git commit -m "feat: confine uploads to workspace files"
```

## Task 6: Implement the Aliyun Provider, directory creation, and multipart upload

**Files:**

- Create: `src/providers/aliyun/provider.ts`
- Create: `src/providers/aliyun/upload.ts`
- Test: `tests/unit/aliyun-provider.test.ts`
- Test: `tests/unit/aliyun-upload.test.ts`

- [ ] **Step 1: Write failing credential validation tests**

The fake server sequence must be:

```text
POST /oauth/access_token
POST /adrive/v1.0/user/getDriveInfo
```

Assert `validateCredentials()` returns a complete record using the same supplied `client_id` and `client_secret`, the rotated `refresh_token`, a masked user ID, and an ISO expiry.

Assert an invalid candidate never calls `CredentialStore.replace`; old credentials remain readable.

- [ ] **Step 2: Write failing recursive directory tests**

For `/openClawShare/reports/2026`, assert the provider:

1. Starts with parent ID `root`.
2. Calls `POST /adrive/v1.0/openFile/list` for each segment.
3. Calls `POST /adrive/v1.0/openFile/create` only for missing segments with `type: "folder"` and `check_name_mode: "refuse"`.
4. Handles a create race by listing again when the API reports an already-existing name.

- [ ] **Step 3: Write failing multipart upload tests**

Use a 45 MiB sparse test file and assert:

```text
create request: 3 part_info_list entries
PUT part 1: 20 MiB
PUT part 2: 20 MiB
PUT part 3: 5 MiB
complete request occurs after all PUT requests
check_name_mode is auto_rename
returned remote name is the server-resolved name
```

Also test a zero-byte file with an empty `part_info_list` followed by complete.

- [ ] **Step 4: Write failing retry/error tests**

Cover:

- A file-create 401 triggers `TokenManager.forceRefresh(oldToken)` and retries once.
- A second 401 maps to `AUTHORIZATION_REVOKED`.
- Upload URL older than 50 minutes is refreshed through `POST /adrive/v1.0/openFile/getUploadUrl`.
- 429 maps to `RATE_LIMITED`.
- capacity error maps to `QUOTA_EXCEEDED`.
- a failed PUT maps to `UPLOAD_FAILED` without logging its signed URL.

- [ ] **Step 5: Run the provider tests and confirm failure**

Run: `npm test -- --run tests/unit/aliyun-provider.test.ts tests/unit/aliyun-upload.test.ts`

Expected: FAIL because Provider methods are absent.

- [ ] **Step 6: Implement account and drive discovery**

Use:

```text
POST /adrive/v1.0/user/getDriveInfo
```

Drive selection order is `default_drive_id`, then `resource_drive_id`, then `backup_drive_id`. If none exists, throw `CREDENTIALS_INVALID`.

Account display rules:

- Prefer a returned display name when the official response includes one.
- Otherwise mask `user_id`.
- Never persist or return an unmasked account identifier.

- [ ] **Step 7: Implement directory traversal**

List with `limit: 200` and follow `marker` until empty. Cache resolved `(driveId, normalizedPath) -> fileId` only for the current upload operation; do not persist directory IDs.

- [ ] **Step 8: Implement streaming multipart upload**

Constants:

```ts
const MIN_PART_SIZE = 20 * 1024 * 1024;
const MAX_PARTS = 10_000;
const UPLOAD_URL_REFRESH_AGE_MS = 50 * 60 * 1000;
```

Calculate:

```ts
const partSize = Math.max(MIN_PART_SIZE, Math.ceil(fileSize / MAX_PARTS));
```

Read each byte range from the already-open file handle. Limit concurrent PUTs to three. Do not buffer the whole file. Call:

```text
POST /adrive/v1.0/openFile/create
PUT <signed upload_url>
POST /adrive/v1.0/openFile/complete
```

- [ ] **Step 9: Run the focused tests**

Run: `npm test -- --run tests/unit/aliyun-provider.test.ts tests/unit/aliyun-upload.test.ts`

Expected: PASS.

- [ ] **Step 10: Commit the Aliyun Provider**

```bash
git add src/providers/aliyun/provider.ts src/providers/aliyun/upload.ts tests/unit/aliyun-provider.test.ts tests/unit/aliyun-upload.test.ts
git commit -m "feat: upload files through aliyun openapi"
```

## Task 7: Add upload orchestration and per-file partial results

**Files:**

- Create: `src/upload/orchestrator.ts`
- Test: `tests/unit/orchestrator.test.ts`

- [ ] **Step 1: Write failing success and partial-result tests**

Use fake Provider and path guard adapters. Assert:

```ts
expect(await orchestrator.upload({
  workspaceDir,
  paths: ["a.txt", "b.txt"],
})).toEqual({
  provider: "aliyun",
  remoteDirectory: "/openClawShare",
  status: "success",
  files: [
    { inputName: "a.txt", remoteName: "a.txt", size: 1, status: "uploaded" },
    { inputName: "b.txt", remoteName: "b (1).txt", size: 1, status: "uploaded" },
  ],
});
```

Make the second Provider call throw `QUOTA_EXCEEDED`; assert overall `partial`, first file remains uploaded, and the second file contains only the stable error code.

- [ ] **Step 2: Write failing precondition tests**

Cover:

- empty `paths` is rejected;
- more than 100 paths is rejected;
- duplicate canonical files are uploaded once;
- unconfigured Vault returns `CREDENTIALS_REQUIRED`;
- omitted Provider selects `aliyun`;
- omitted directory selects configured `/openClawShare`;
- every opened file handle closes on success and failure.

- [ ] **Step 3: Run the test and confirm failure**

Run: `npm test -- --run tests/unit/orchestrator.test.ts`

Expected: FAIL because the orchestrator is absent.

- [ ] **Step 4: Implement the orchestration sequence**

```text
resolve provider
normalize remote directory
load/refresh access token
ensure remote directory once
resolve and deduplicate local files
upload files sequentially
close every file handle in finally
aggregate success / partial / failed
```

Use sequential per-file uploads in v1 so one request cannot create unbounded multipart concurrency. Continue after individual failures.

- [ ] **Step 5: Run the focused test**

Run: `npm test -- --run tests/unit/orchestrator.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit orchestration**

```bash
git add src/upload/orchestrator.ts tests/unit/orchestrator.test.ts
git commit -m "feat: orchestrate multi-file uploads"
```

## Task 8: Register the Agent Tool and semantic trigger Skill

**Files:**

- Create: `src/tool.ts`
- Create: `skills/pan-sync-upload/SKILL.md`
- Test: `tests/integration/tool.test.ts`

- [ ] **Step 1: Write the failing Tool registration and redaction tests**

Assert the factory creates:

```ts
expect(tool.name).toBe("pan_sync_upload");
expect(tool.parameters).toMatchObject({
  type: "object",
  required: ["paths"],
});
```

Execute with a fake orchestrator and assert output uses OpenClaw `jsonResult`, contains the safe result, and never includes fake access/refresh tokens or the absolute workspace path.

- [ ] **Step 2: Run the test and confirm failure**

Run: `npm test -- --run tests/integration/tool.test.ts`

Expected: FAIL because `src/tool.ts` does not exist.

- [ ] **Step 3: Implement the exact Tool schema**

```ts
const PanSyncUploadSchema = Type.Object(
  {
    paths: Type.Array(Type.String({ minLength: 1 }), {
      minItems: 1,
      maxItems: 100,
    }),
    provider: Type.Optional(Type.Literal("aliyun")),
    remoteDirectory: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);
```

Register through an `api.registerTool` factory whose callback receives `context`; pass only `context.workspaceDir` as workspace authority to the orchestrator.

- [ ] **Step 4: Write the Skill**

Use this frontmatter and behavioral contract:

```md
---
name: pan-sync-upload
description: Upload concrete OpenClaw workspace files when the user explicitly asks to push, upload, or sync results to a cloud drive.
---
```

The body must state:

- `阿里网盘`、`阿里云盘`、`aliyun`、`alipan` map to `aliyun`.
- An explicit upload/sync/push verb plus “网盘” uses the default Provider.
- Merely discussing cloud drives does not call the Tool.
- Generate the requested artifact first, confirm the path exists, then call the Tool.
- Never invent a path and never upload the same canonical file twice in one request.
- If `CREDENTIALS_REQUIRED`, tell the user to open the Pan Sync Helper status tab and run its configuration command.

- [ ] **Step 5: Run the Tool test and validate Skill discovery metadata**

Run: `npm test -- --run tests/integration/tool.test.ts`

Run: `node -e "const m=require('./openclaw.plugin.json'); if(!m.skills.includes('skills/pan-sync-upload')) process.exit(1)"`

Expected: both commands pass.

- [ ] **Step 6: Commit Tool and Skill**

```bash
git add src/tool.ts skills/pan-sync-upload/SKILL.md tests/integration/tool.test.ts
git commit -m "feat: expose pan sync upload tool"
```

## Task 9: Build the one-time loopback credential configuration page

**Files:**

- Create: `src/admin/setup-page.ts`
- Create: `src/admin/setup-server.ts`
- Create: `src/admin/cli.ts`
- Create: `ui/setup.html`
- Create: `ui/setup.js`
- Create: `ui/setup.css`
- Test: `tests/integration/admin-server.test.ts`
- Test: `tests/integration/admin-cli.test.ts`

- [ ] **Step 1: Write failing server binding and expiry tests**

Inject a fake `http.createServer` wrapper and clock. Assert:

```ts
expect(listenHost).toBe("127.0.0.1");
expect(result.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/#[A-Za-z0-9_-]{43}$/);
expect(result.url).not.toContain("?");
```

Advance the clock past ten minutes and assert the server closes and the access key no longer authorizes requests.

- [ ] **Step 2: Write failing authorization and security-header tests**

Cover:

```text
GET /                         -> 200, no credentials, no-store, strict CSP
GET /api/config no header    -> 401
GET /api/config valid header -> 200, full saved values
PUT /api/config valid header -> validate then atomically replace
DELETE /api/config           -> requires confirm="CLEAR", then clears
all other routes             -> 404
all request bodies >64 KiB   -> 413
```

The header format is exactly:

```text
Authorization: PanSyncSetup <43-character-base64url-token>
```

- [ ] **Step 3: Write failing candidate-preservation tests**

Start with valid stored credentials. Submit an invalid `client_secret` or mismatched `refresh_token`. Assert:

- response code is `CREDENTIALS_INVALID` or `REFRESH_TOKEN_REJECTED`;
- response body does not include the official raw body;
- existing Vault contents are unchanged;
- the access key remains usable so the user can correct the form.

- [ ] **Step 4: Write failing browser behavior tests**

Run the real page scripts in a browser-compatible test environment and assert observable behavior:

- opening `/#<access-key>` removes the fragment before the first network request;
- a reload in the same tab restores only the page access key from `sessionStorage`;
- all API requests send `Authorization: PanSyncSetup <access-key>`;
- Client ID、Client Secret、Refresh Token use non-masked text inputs with autocomplete disabled;
- credentials never enter `localStorage`、request URL、console output or rendered error details;
- `pagehide` clears all three form values;
- the first Clear click only opens a second confirmation, and DELETE is sent only after confirmation.

- [ ] **Step 5: Run the admin tests and confirm failure**

Run: `npm test -- --run tests/integration/admin-server.test.ts tests/integration/admin-cli.test.ts`

Expected: FAIL because the admin modules and assets are absent.

- [ ] **Step 6: Implement the setup server**

`startSetupServer` dependencies:

```ts
type SetupServerDependencies = {
  store: CredentialStore;
  provider: AliyunProvider;
  orchestrator: UploadOrchestrator;
  dataDir: string;
  assetsDir: string;
  clock: () => number;
  randomBytes: (size: number) => Buffer;
};
```

Security response headers on every route:

```text
Cache-Control: no-store
Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'none'; font-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'
Referrer-Policy: no-referrer
X-Content-Type-Options: nosniff
Cross-Origin-Opener-Policy: same-origin
```

Permit only loopback `Host` values. Reject `X-Forwarded-Host`, `Forwarded`, and non-loopback hostnames because this page is not proxy-aware.

- [ ] **Step 7: Implement save, revalidate, clear, and test-upload actions**

`PUT /api/config` must:

1. Validate field length and non-empty input.
2. Refresh with the candidate triple.
3. Read drive/account summary.
4. Construct a complete record with `credentialVersion = current + 1`.
5. Atomically replace under the shared state lease.
6. Return full saved values only to the still-authorized page.

`POST /api/revalidate` repeats official validation without changing client fields unless the server rotates tokens successfully.

`POST /api/test-upload` creates a small random text file under `dataDir/tmp`, calls the normal `UploadOrchestrator` with that temporary directory as its explicit `workspaceDir`, uploads to `/openClawShare`, closes and deletes the local file in `finally`, and returns only remote name/directory.

- [ ] **Step 8: Implement the OpenClaw CLI command**

Register:

```text
openclaw pan-sync configure
```

The command resolves:

```ts
const dataDir = path.join(api.runtime.state.resolveStateDir(), "pan-sync-helper");
```

It starts the server on port `0`, prints:

```text
Pan Sync Helper configuration page is ready for 10 minutes.
Remote URL: http://127.0.0.1:${port}/#${oneTimeKey}
SSH example: ssh -L ${port}:127.0.0.1:${port} user@linux.example.com
Then open the Remote URL in your local browser.
```

Do not print stored credentials. Handle `SIGINT` and `SIGTERM` by closing the server and zeroing the in-memory access-key buffer.

- [ ] **Step 9: Implement the browser page**

The page must show:

- warning that administrators, screen sharing, browser extensions, and screenshots can see full values;
- Client ID, Client Secret, Refresh Token as non-masked text inputs;
- Save and verify, Revalidate, Test upload, Clear credentials;
- default directory and optional Token guide URL;
- explicit statement that AList is only one possible initial-token tool and the user must choose custom client credentials.

After successful save or clear, keep the page alive for 60 seconds to show the result, then close the server.

- [ ] **Step 10: Run the admin tests**

Run: `npm test -- --run tests/integration/admin-server.test.ts tests/integration/admin-cli.test.ts`

Expected: PASS.

- [ ] **Step 11: Commit the configuration page**

```bash
git add src/admin/cli.ts src/admin/setup-page.ts src/admin/setup-server.ts ui/setup.html ui/setup.js ui/setup.css tests/integration/admin-server.test.ts tests/integration/admin-cli.test.ts
git commit -m "feat: add secure loopback configuration page"
```

## Task 10: Add the read-only Control UI status page and plugin composition root

**Files:**

- Create: `src/admin/status-route.ts`
- Create: `src/index.ts`
- Test: `tests/integration/plugin-entry.test.ts`

- [ ] **Step 1: Write the failing plugin registration test**

Use a fake `OpenClawPluginApi` recorder and assert:

```ts
expect(registrations.tools).toContain("pan_sync_upload");
expect(registrations.cliCommands).toContain("pan-sync");
expect(registrations.httpRoutes).toContainEqual(
  expect.objectContaining({
    path: "/plugins/pan-sync-helper/status",
    auth: "gateway",
    match: "exact",
  }),
);
expect(registrations.controlUi).toContainEqual(
  expect.objectContaining({
    surface: "tab",
    id: "pan-sync-helper",
    requiredScopes: ["operator.write"],
    path: "/plugins/pan-sync-helper/status",
  }),
);
```

- [ ] **Step 2: Write failing status-page disclosure tests**

With a populated Vault, assert the HTML includes:

- Provider `aliyun`;
- status `ready`;
- masked client/account summary;
- `/openClawShare`;
- `openclaw pan-sync configure`;
- the configuration command `openclaw pan-sync configure`.

Assert it does not include `client_secret`, `refresh_token`, `access_token`, raw user ID, or official response content.

- [ ] **Step 3: Run the test and confirm failure**

Run: `npm test -- --run tests/integration/plugin-entry.test.ts`

Expected: FAIL because entry and status route are absent.

- [ ] **Step 4: Implement the read-only route**

Allow only `GET` and `HEAD`. Add:

```text
Cache-Control: no-store
Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'
Referrer-Policy: no-referrer
X-Content-Type-Options: nosniff
```

Render no JavaScript and no external resource. Display these states:

```text
unconfigured
ready
degraded
reauth_required
```

- [ ] **Step 5: Implement `definePluginEntry` composition**

The entry must:

1. Parse only non-secret config.
2. Resolve `dataDir = <stateDir>/pan-sync-helper`.
3. Construct the approved Worker-owned SQLite transaction lease at `<dataDir>/locks/lease.sqlite` and adapt it to the Vault. Do not call privileged `state.withLease`, `openKeyedStore`, or `openSyncKeyedStore` from this third-party plugin.
4. Construct one shared store, HTTP client, Token Manager, Aliyun Provider, Provider Registry, and Orchestrator.
5. Register Tool factory.
6. Register CLI command `pan-sync configure`.
7. Register the gateway-authenticated status route.
8. Register the `operator.write` Control UI tab.
9. Register a service whose `start` initializes directory permissions and whose `stop` clears process-local token/status snapshots.

Do not register credential Gateway methods in v1 because the external iframe cannot securely invoke write-scoped methods.

- [ ] **Step 6: Run integration and complete unit tests**

Run: `npm test -- --run tests/integration/plugin-entry.test.ts`

Run: `npm test -- --run`

Expected: all tests PASS.

- [ ] **Step 7: Commit plugin integration**

```bash
git add src/admin/status-route.ts src/index.ts tests/integration/plugin-entry.test.ts
git commit -m "feat: integrate pan sync helper with openclaw"
```

## Task 11: Document setup, AList custom-client use, and the separate Token Web system

**Files:**

- Create: `README.md`
- Create: `docs/guides/aliyun-token.md`
- Create: `docs/plans/token-acquisition-web-system.md`

- [ ] **Step 1: Write the README user journey**

Order the README exactly as:

1. What problem the plugin solves.
2. Requirements and installation.
3. Register an Aliyun Drive Open Platform application.
4. Obtain an initial Refresh Token using the same custom Client ID/Secret.
5. Run `openclaw pan-sync configure`.
6. SSH port-forward example for remote Linux.
7. Save/verify credentials and test upload.
8. Conversation examples.
9. Security model and recovery.
10. Known v1 limits.

Include these conversation examples:

```text
把 report.pdf 推送到阿里网盘
把刚生成的结果上传到 aliyun
生成报告并把结果推送到网盘
```

State that `网盘里一般放什么文件？` must not trigger upload.

- [ ] **Step 2: Write the initial-token guide**

The guide must clearly distinguish:

```text
AList public/default client mode          -> not supported by this plugin
AList custom Client ID + Client Secret    -> acceptable source of the initial token
Other trusted custom-client tools         -> acceptable
Plugin runtime refresh                    -> official Aliyun endpoint, no AList dependency
```

Link to the AList custom-client documentation and tell users to verify that all three values belong to one OAuth application.

- [ ] **Step 3: Write the separate Web system plan**

`docs/plans/token-acquisition-web-system.md` is a planning deliverable only and must specify:

- user supplies their own Client ID and Client Secret;
- service starts OAuth authorization with high-entropy, one-time `state`;
- callback exchanges the code using the same client credentials;
- Refresh Token is displayed once and never persisted;
- HTTPS, strict callback allowlist, CSP, CSRF, rate limits, no request-body APM, no secret logging;
- no runtime refresh API, no file proxy, no plugin dependency;
- self-hosted mode is recommended for high-security users;
- deployment, privacy review, abuse controls, and Aliyun platform compliance are separate gates.

- [ ] **Step 4: Check docs for contradictory login claims**

Run:

```powershell
rg -n "二维码|扫码|公共.*刷新|AList.*依赖|Control UI.*完整" README.md docs
```

Expected: every match either states an explicit non-goal, historical design correction, or warning; no instruction tells the plugin to scan a QR code or use an AList refresh service.

- [ ] **Step 5: Commit documentation**

```bash
git add README.md docs/guides/aliyun-token.md docs/plans/token-acquisition-web-system.md
git commit -m "docs: add installation and token guidance"
```

## Task 12: Add package, leakage, and release verification gates

**Files:**

- Modify: `package.json`
- Modify: `scripts/copy-assets.mjs`
- Create: `tests/integration/package.test.ts`
- Create: `tests/integration/leakage.test.ts`

- [ ] **Step 1: Write the failing package-content test**

Build and inspect `npm pack --json --dry-run`. Assert the tarball includes:

```text
dist/index.js
dist/admin/cli.js
ui/setup.html
ui/setup.js
ui/setup.css
skills/pan-sync-upload/SKILL.md
openclaw.plugin.json
README.md
```

Assert it excludes `tests/`, `.env`, `plugin-data/`, `master.key`, and `credentials.enc`.

- [ ] **Step 2: Write the failing leakage canary test**

Use canaries:

```text
client-secret-CANARY-8b26
refresh-token-CANARY-19d4
access-token-CANARY-62a1
/srv/private/openclaw/workspace/report.pdf
```

Exercise invalid credentials, refresh failure, path rejection, upload failure, Tool serialization, status HTML, and logger calls. Assert none of the canaries appear in outputs except the authenticated one-time `/api/config` response.

- [ ] **Step 3: Run the new tests and confirm any missing build behavior**

Run: `npm test -- --run tests/integration/package.test.ts tests/integration/leakage.test.ts`

Expected: FAIL until asset copy and package assertions are complete.

- [ ] **Step 4: Complete asset copying and package scripts**

`scripts/copy-assets.mjs` must verify all three `ui/` assets exist and must not rewrite secrets or runtime state. `npm run build` must start from a clean `dist/` created by TypeScript output, then copy only required static assets when the runtime loader expects them under `dist`.

Add:

```json
{
  "scripts": {
    "test:unit": "vitest run tests/unit",
    "test:integration": "vitest run tests/integration",
    "test:leakage": "vitest run tests/integration/leakage.test.ts",
    "verify": "npm run typecheck && npm run test:unit && npm run test:integration && npm run build && npm pack --dry-run"
  }
}
```

- [ ] **Step 5: Run the complete automated gate**

Run: `npm run verify`

Expected:

```text
TypeScript typecheck: PASS
Unit tests: PASS
Integration tests: PASS
Build: PASS
npm pack --dry-run: PASS
```

- [ ] **Step 6: Inspect the actual tarball**

Run:

```powershell
$pack = npm pack --json | ConvertFrom-Json
$tgz = $pack[0].filename
tar -tf $tgz
```

Expected: only intended package files. Move the generated `.tgz` out of the repository or delete only that exact generated file after inspection.

- [ ] **Step 7: Commit verification gates**

```bash
git add package.json package-lock.json scripts/copy-assets.mjs tests/integration/package.test.ts tests/integration/leakage.test.ts
git commit -m "test: add package and secret leakage gates"
```

## Task 13: Repair CLI metadata loading, then perform OpenClaw acceptance

**Files:**

- Create: `cli-metadata.js`
- Create: `src/runtime-composition.ts`
- Create: `src/cli-entry.ts`
- Modify: `src/index.ts`
- Modify: `src/admin/cli.ts`
- Modify: `package.json`
- Modify: `tests/integration/admin-cli.test.ts`
- Modify: `tests/integration/package.test.ts`
- Modify: `README.md`
- Create: `docs/verification/2026-07-31-v0.1.0.md`

**Interfaces:**

- `createPanSyncRuntime(options: { stateDir: string; pluginConfig: unknown;
  credentialLeaseFactory?: (databasePath: string) => CredentialLeaseRunner })`
  returns the single shared Store/Token/Provider/Registry/Orchestrator composition used by
  both the full plugin and CLI entry.
- `registerPanSyncConfigureCommand(program, dependencies, options?)` attaches
  `pan-sync configure` to a Commander-compatible program and never resolves OpenClaw state.
- `registerPanSyncCli(program, options: { pluginConfig: unknown; pluginRoot: string })`
  resolves state with `openclaw/plugin-sdk/state-paths`, creates the shared runtime, and
  attaches the configuration command.
- Root `cli-metadata.js` registers only the `pan-sync` descriptor and lazily imports
  `./dist/cli-entry.js` from its registrar; it must not import the full plugin entry.

- [ ] **Step 1: Write failing CLI metadata and package tests**

Update `tests/integration/admin-cli.test.ts` so its fake API has no `runtime.state` and the
command receives a prepared `dataDir`. Assert command registration and launch never read a
runtime state facade.

Update `tests/integration/package.test.ts` to require `cli-metadata.js` and
`dist/cli-entry.js`. Add an installed-package regression that:

1. runs `npm pack --json --pack-destination <unique-temp-dir>` after the existing build;
2. installs that exact tarball into a fresh `OPENCLAW_STATE_DIR` with the official OpenClaw
   `plugins install` command;
3. spawns the official `openclaw --no-color pan-sync configure` command;
4. waits until stdout contains the sanitized readiness marker `Remote URL:`;
5. asserts the process did not report `cli-metadata` registration failure or `Unknown command`;
6. sends `SIGTERM`, waits for exit, and force-terminates only that exact child if the graceful
   deadline expires; and
7. deletes only its unique temporary directory in `finally`.

The test may hold raw child output only in memory. Failure diagnostics must redact URL
fragments and must never print credentials, dynamic ports, or absolute state paths.

- [ ] **Step 2: Run the focused tests and confirm RED**

Run:

```powershell
volta run --node 22.23.1 npm test -- --run tests/integration/admin-cli.test.ts tests/integration/package.test.ts
```

Expected: FAIL because there is no root `cli-metadata.js`, `dist/cli-entry.js`, or
runtime-independent command registrar, and the official packed command is not recognized.

- [ ] **Step 3: Add the lightweight metadata entry and shared runtime composition**

Create root `cli-metadata.js` with a `definePluginEntry` registration whose only side effect
is `api.registerCli(...)`. The registrar must dynamically import `./dist/cli-entry.js` only
when OpenClaw invokes it, pass `api.pluginConfig` and `api.rootDir`, and publish this exact
descriptor:

```js
{
  name: "pan-sync",
  description: "Configure Pan Sync Helper",
  hasSubcommands: true,
}
```

Create `src/runtime-composition.ts` and move the existing construction of Credential Store,
SQLite Worker lease, Token Manager, Aliyun client/provider, Provider Registry, and Upload
Orchestrator out of `src/index.ts`. The caller supplies the already resolved state root; the
function derives `<stateDir>/pan-sync-helper` and the lease database beneath it.

Create `src/cli-entry.ts`. It imports `resolveStateDir` only from
`openclaw/plugin-sdk/state-paths`, constructs the shared runtime with
`options.pluginConfig`, uses `options.pluginRoot/ui` for setup assets, and calls
`registerPanSyncConfigureCommand`.

Refactor `src/admin/cli.ts` so `registerPanSyncConfigureCommand` accepts the program and
already prepared `SetupServerDependencies`. Keep a small full-runtime `registerCli` adapter
only if `src/index.ts` still needs it. Neither command attachment nor action execution may
dereference `api.runtime.state`.

Update `src/index.ts` to use `createPanSyncRuntime` for full registration and update
`package.json.files` so the exact root `cli-metadata.js` is published.

- [ ] **Step 4: Run focused tests and confirm GREEN**

Run:

```powershell
volta run --node 22.23.1 npm test -- --run tests/integration/admin-cli.test.ts tests/integration/package.test.ts
```

Expected: PASS, including the actual packed-install invocation of the official
`openclaw pan-sync configure` command.

- [ ] **Step 5: Run the complete automated gate**

Run:

```powershell
volta run --node 22.23.1 npm run verify
```

Expected: typecheck, unit tests, integration tests, build, and package dry run all PASS. The
package inspection must include root `cli-metadata.js` and exclude `src/`, `tests/`,
`node_modules/`, `.superpowers/`, state files, keys, and credentials.

- [ ] **Step 6: Commit the CLI metadata repair**

```bash
git add cli-metadata.js src/runtime-composition.ts src/cli-entry.ts src/index.ts src/admin/cli.ts package.json tests/integration/admin-cli.test.ts tests/integration/package.test.ts
git commit -m "fix: support openclaw cli metadata loading"
```

- [ ] **Step 7: Install the repaired packed plugin into an isolated OpenClaw test state**

Create a new exact tarball from the reviewed repair commit and a fresh temporary OpenClaw
state directory. Do not reuse the pre-fix Task 12 artifact as acceptance evidence. Record the
artifact SHA-256, OpenClaw version, and Node version in the verification note; do not record
tokens, URL fragments, dynamic ports, paths outside the temporary state, or raw logs.

- [ ] **Step 8: Verify plugin discovery without credentials**

Confirm:

- plugin loads without diagnostics;
- `pan_sync_upload` is registered;
- `pan-sync-upload` Skill is discoverable;
- Control UI shows the status tab only to an `operator.write` session;
- Tool returns `CREDENTIALS_REQUIRED` with safe setup guidance.

- [ ] **Step 9: Verify the official loopback configuration flow**

Run the official installed `openclaw pan-sync configure`. If a remote Linux host is
available, establish the printed SSH tunnel; otherwise record the remote-tunnel criterion as
`NOT RUN` and exercise the actual loopback page locally without substituting a handler harness.
Verify:

- the server listens only on `127.0.0.1`;
- the fragment disappears from the address bar;
- invalid candidate credentials do not replace the old record;
- valid credentials remain fully visible after page reload within the same browser tab;
- server closes after save/clear completion or ten-minute timeout;
- file modes are `0700/0600/0600`.

- [ ] **Step 10: Run the dedicated real-account matrix**

With a dedicated Aliyun test application and account:

1. Obtain the initial Refresh Token through a third-party custom-client flow.
2. Save and validate the matching Client ID, Client Secret, and Refresh Token.
3. Upload a small file to `/openClawShare`.
4. Upload the same name again and confirm automatic rename.
5. Upload a file larger than 40 MiB and confirm multipart completion.
6. Upload two files where one intentionally fails and confirm a partial result.
7. Force access-token expiry and confirm direct refresh plus rotated Refresh Token persistence.
8. Restart OpenClaw and upload again.
9. Confirm Chinese and English trigger phrases.
10. Inspect sanitized logs and conversation output for credential/path leakage.

- [ ] **Step 11: Record evidence with separate gate statuses**

The verification note must contain:

```text
Automated gate: PASS/FAIL
OpenClaw integration smoke gate: PASS/FAIL
Real Aliyun account gate: PASS/FAIL/NOT RUN
Package inspection gate: PASS/FAIL
Release decision: READY/BLOCKED
```

If the real-account gate is not run, use `NOT RUN` and keep the release decision `BLOCKED`.

- [ ] **Step 12: Run final diff and repository checks**

Run:

```powershell
git status --short
git diff --check
npm run verify
```

Expected: no unexpected files, no whitespace errors, all automated checks pass.

- [ ] **Step 13: Commit the verified documentation**

```bash
git add README.md docs/verification/2026-07-31-v0.1.0.md
git commit -m "docs: record v0.1.0 verification"
```
