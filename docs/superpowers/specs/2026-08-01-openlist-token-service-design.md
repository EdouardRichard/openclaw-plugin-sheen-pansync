# OpenList 授权与 Token 维护设计

- 日期：2026-08-01
- 状态：批准
- 适用版本：Pan Sync Helper 下一版本
- 首版网盘：单一阿里云盘账号

## 1. 背景

阿里云盘当前不再适合让本插件的任意个人用户分别申请开放平台应用。Pan Sync Helper 因此不再要求用户提供自己的 `client_id` 和 `client_secret`，改用 OpenList APIPages 提供的授权页面与在线刷新服务维护阿里云盘 Token。

OpenList 只参与初次授权和 Token 刷新。文件夹查询、目录创建、分片上传和完成上传仍由插件直接请求阿里云盘 OpenAPI，文件内容不经过 OpenList。

## 2. 已确认的产品决策

1. 采用 OpenList 授权页面完成扫码授权，用户把取得的 `refresh_token` 手工粘贴到插件配置页。
2. 插件不集成 OpenList 的扫码、回调或轮询流程。
3. 配置页不再收集 `client_id`、`client_secret` 或 `access_token`。
4. 第一次保存因本地没有 `access_token`，允许调用一次 OpenList 刷新 API 完成验证。
5. 日常运行完全被动刷新：不根据本地时间或提前窗口刷新，仅在阿里云盘明确拒绝当前 access token 后刷新。
6. OpenList 返回的新 `access_token` 与轮换后的 `refresh_token` 必须一起原子保存。
7. `refresh_token` 本身失效时不能自动恢复，状态转为 `reauth_required`，要求用户重新扫码授权。
8. 默认使用 OpenList 中国大陆节点；授权页面 URL 与刷新 API URL 是两个独立、完整且可编辑的字段。
9. 默认授权页面为 `https://api.oplist.org.cn`。
10. 默认刷新 API 为 `https://api.oplist.org.cn/alicloud/renewapi`。
11. 自定义 URL 不设 HTTPS、域名、IP、端口、用户信息或网络范围限制；用户承担把 refresh token 发送到该地址的风险。
12. 不兼容、不迁移当前自建应用凭证格式；当前版本尚未投入使用。
13. OpenList 刷新请求不做立即自动重试，并持久化限流与失败冷却。

## 3. 目标

- 让没有阿里云盘个人开发者应用的任意用户可以配置单一阿里云盘账号。
- 最大限度减少同一主机 IP 对 OpenList 在线刷新服务的调用。
- 保留当前加密 Vault、跨进程租约、single-flight 与 CAS 轮换保证。
- 保持上传 Provider 抽象，使后续网盘可以实现各自的 TokenService。
- 保持现有上传、目录、路径安全、Tool 和 Skill 行为不变。

## 4. 非目标

- 不实现插件内扫码登录、OAuth 回调、二维码轮询或公共回调服务。
- 不部署或维护 OpenList APIPages 服务。
- 不支持旧 `client_id + client_secret + refresh_token` 凭证迁移。
- 不保留阿里官方 Token 端点作为运行时回退。
- 不自动在中国大陆、全球或自定义节点之间切换。
- 不让文件数据经过 OpenList。
- 不新增第二个网盘或第二个阿里账号。

## 5. 总体架构

上传主链路保持不变：

```text
OpenClaw Tool
  -> UploadOrchestrator
  -> ProviderRegistry
  -> AliyunProvider
  -> Aliyun Drive file OpenAPI
```

认证链路调整为：

```text
Loopback setup page
  -> OpenList authorization page (user scans externally)
  -> user pastes refresh_token
  -> OpenListTokenService
  -> configured OpenList renew API
  -> encrypted Credential Vault
  -> TokenManager
```

`OpenListTokenService` 只封装 OpenList 在线刷新协议。`TokenManager` 负责本地 Token 状态、跨调用并发合并、冷却、CAS 和持久化。`AliyunProvider` 负责识别阿里云盘明确的 access token 失效结果，并触发一次刷新及一次原操作重试。

未来其他网盘可以提供各自的 TokenService；`UploadOrchestrator` 不感知 OpenList 或 OAuth 细节。

## 6. OpenList 请求合约

插件按 OpenList 当前阿里云盘驱动的在线 API 合约调用配置的完整刷新 URL：

- 方法：`GET`
- 查询参数：
  - `refresh_ui=<current refresh token>`
  - `server_use=true`
  - `driver_txt=alicloud_qr`
- 成功响应必须同时包含非空字符串：
  - `access_token`
  - `refresh_token`

请求超时固定为 15 秒。不得立即自动重试。调用方取消时终止请求且不得修改 Vault。

实现使用 URL API 添加上述查询参数。用户填写的是完整刷新 API URL，插件不自动拼接 `/alicloud/renewapi`，也不自动改写主机或协议。

OpenList 协议参考：

- https://doc.oplist.org/ecosystem/official_APIpage
- https://doc.oplist.org/guide/drivers/aliyundrive_open
- https://github.com/OpenListTeam/OpenList/blob/v4.2.4/drivers/aliyundrive_open/util.go

## 7. 凭证模型

Vault 使用新的、唯一受支持的凭证结构：

```ts
type CredentialRecord = {
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
  refreshState: {
    status: "ready" | "degraded" | "rate_limited" | "reauth_required";
    notBefore?: string;
    failureCode?: "TOKEN_ENDPOINT_UNAVAILABLE" | "RATE_LIMITED" | "REFRESH_TOKEN_REJECTED";
  };
};
```

删除 `clientId`、`clientSecret` 和 `accessTokenExpiresAt`。插件不读取或迁移 `formatVersion: 1`。新配置成功后以现有 AES-256-GCM、原子替换、目录 `0700`、文件 `0600` 规则保存。

URL 与 Token 一起存放在加密 Vault 中。原因是自定义 URL 可能包含私有主机名、路径或查询内容，不应出现在普通插件配置、日志或 Control UI。

## 8. 初次配置流程

1. 用户运行 `openclaw pan-sync configure`。
2. 插件继续只在 `127.0.0.1` 启动十分钟的一次性配置页。
3. 页面显示默认授权 URL、默认刷新 API URL 和可编辑输入框。
4. 用户打开授权链接，在 OpenList 页面选择阿里云盘扫码授权。
5. 用户复制 refresh token，返回配置页填写。
6. 页面明确警告：refresh token 将发送到当前刷新 API URL；HTTP、自建或第三方服务的风险由用户承担。
7. 保存时，服务端检查两个 URL 能被 URL/fetch 处理，但不执行 HTTPS、域名、IP、端口或网络范围限制。
8. 服务端调用一次 OpenList 刷新 API。
9. 使用返回的 access token 调用阿里云盘账号/网盘信息接口，验证 Token 确实可用并生成脱敏账号摘要。
10. 刷新和账号验证都成功后，原子替换 Vault；任一步失败都保留原 Vault。

配置页完整回显 refresh token、授权页面 URL 和刷新 API URL，沿用用户已确认的自查输入要求。Access token 不提供输入框且永不回显。

## 9. 运行时被动刷新

`TokenManager.getValidAccessToken()` 不再检查本地过期时间。存在非空 access token 且不处于阻塞状态时，直接返回该 token。

阿里云盘请求明确返回 `AccessTokenInvalid`、`AccessTokenExpired` 或经测试确认的等价 Token 失效结果时：

1. Provider 把当前 access token 作为预期值请求刷新。
2. 如果另一个进程已经轮换 Token，直接使用胜出的新 access token，不再次调用 OpenList。
3. 否则通过现有跨进程租约和进程内 single-flight 合并刷新。
4. 调用一次配置的 OpenList 刷新 API。
5. CAS 原子保存两个新 Token、清除冷却状态并增加 `credentialVersion`。
6. 原阿里操作使用新 access token 重试一次。
7. 重试仍失败时返回稳定错误，不再刷新或重试。

不得把普通 401、网络失败或非 Token 业务错误无条件解释为需要刷新。具体等价错误集必须由阿里 OpenAPI 测试固定，避免攻击者或上游故障触发刷新风暴。

## 10. 限流、冷却与状态

公开状态为：

- `unconfigured`：没有新格式凭证。
- `ready`：可使用当前 access token。
- `degraded`：刷新服务网络错误、超时或 5xx，处于短冷却。
- `rate_limited`：刷新服务返回 429，处于长冷却。
- `reauth_required`：refresh token 被拒绝或响应不符合 Token 合约。

规则：

| 情况 | 错误码 | 持久化动作 | 后续行为 |
| --- | --- | --- | --- |
| 429 且有有效 `Retry-After` | `RATE_LIMITED` | `notBefore` 采用服务端值 | 截止前不访问 OpenList |
| 429 且无有效 `Retry-After` | `RATE_LIMITED` | 冷却 60 分钟 | 截止前不访问 OpenList |
| 网络错误、超时或 5xx | `TOKEN_ENDPOINT_UNAVAILABLE` | 冷却 1 分钟 | 截止前不访问 OpenList |
| 4xx（429 除外） | `REFRESH_TOKEN_REJECTED` | 标记 `reauth_required` | 不再自动刷新 |
| 2xx 但两个 Token 任一缺失或为空 | `REFRESH_TOKEN_REJECTED` | 标记 `reauth_required` | 不再自动刷新 |

冷却和失败状态写入 Vault，因此 OpenClaw 重启不能绕过。冷却期间继续返回相应稳定错误，不发起网络请求。

用户在配置页主动重新提交时允许发起一次新验证。成功后清除冷却和失败状态；失败时不自动重试。

## 11. 配置页面与 Control UI

配置页删除 Client ID 和 Client Secret 字段，保留：

- OpenList 授权页面 URL；
- 打开授权页面的链接；
- OpenList 刷新 API URL；
- Refresh Token；
- 保存并验证；
- 重新验证；
- 测试上传；
- 清除凭证及二次确认。

普通插件配置中的旧 `tokenGuideUrl` 删除。两个 OpenList URL 只通过一次性配置页维护。

Control UI 继续只读，只显示：

- Provider：Aliyun；
- Token service：OpenList；
- 是否已配置；
- 脱敏账号；
- `ready/degraded/rate_limited/reauth_required/unconfigured`；
- 最近验证时间。

Control UI 不显示 refresh token、access token 或两个 URL。

## 12. 安全与泄漏边界

- Refresh token 只发送到用户当前配置的刷新 API URL。
- 不自动回退或复制到其他 OpenList 节点。
- 自定义 URL 可以是 HTTP、内网、公网或第三方服务；配置页必须明确风险，但不得代替用户阻止。
- Token、完整自定义 URL、原始 OpenList 响应、阿里原始响应、调用栈和绝对工作区路径不得进入日志、Tool 结果或普通错误。
- 配置页继续使用一次性 fragment 密钥、`sessionStorage`、严格 CSP、`no-store`、Host/转发头防护和请求体上限。
- 配置保存失败时，内存中的提交 Token 及时清除，磁盘旧凭证保持不变。
- 外部服务受用户信任边界控制；插件不声明 OpenList 官方或自建服务的可用性、安全性或永久兼容性。

## 13. 错误模型

继续复用稳定错误码：

- `CREDENTIALS_REQUIRED`
- `CREDENTIALS_INVALID`
- `REFRESH_TOKEN_REJECTED`
- `TOKEN_ENDPOINT_UNAVAILABLE`
- `RATE_LIMITED`

错误详情不得包含 Token、完整 URL 或远端响应。配置页可以用安全文案区分：重新授权、刷新服务暂不可用、刷新限流、URL/响应不符合合约。

## 14. 测试策略

所有实现按 TDD 执行。

### 14.1 OpenListTokenService

- GET 方法与三个查询参数完全匹配。
- 自定义完整 URL 不被自动改写。
- 15 秒超时和调用方取消。
- 成功解析并同时要求两个 Token。
- 429 与 `Retry-After`。
- 4xx、5xx、网络错误、非 JSON、空 Token 和异常响应。
- 错误及快照不泄漏 query 中的 refresh token 或完整 URL。

### 14.2 TokenManager

- access token 存在时不调用刷新服务。
- 首次配置只调用一次。
- 20 个并发请求 single-flight 为一次。
- 跨进程租约与 CAS 只保存一个胜出轮换。
- 预期 access token 已变化时复用胜出值。
- 429、网络失败、5xx 和 reauth 状态持久化。
- 重启后继续遵守冷却。
- 配置页显式提交可以进行一次新验证。
- 成功刷新清除失败状态并轮换两个 Token。

### 14.3 AliyunProvider

- 正常调用零刷新。
- 仅明确 Token 失效码触发刷新。
- 刷新后原操作只重试一次。
- 普通 401、业务错误和网络错误不误触发。
- 多分片和多文件并发共享同一刷新结果。

### 14.4 配置页与集成

- 新字段、默认大陆 URL、完整回显和授权链接。
- Client ID、Client Secret、Access Token 输入彻底移除。
- 自定义 HTTP、内网和公网 URL 可提交。
- 刷新成功但账号验证失败时保留旧 Vault。
- Control UI 只显示脱敏状态。
- 泄漏、打包、OpenClaw 正式安装、CLI 元数据和浏览器行为回归。

## 15. 验收与发布门

自动化、真实服务和发布包继续是独立门：

1. 全量 typecheck、unit、integration、build、package gate 通过。
2. 在实际 OpenClaw 安装中完成配置页和 Tool smoke。
3. 使用 OpenList 中国大陆官方授权页取得真实 refresh token。
4. 首次保存验证成功并上传到 `/openClawShare`。
5. 在可控测试中证明有效 access token 不访问 OpenList，明确失效后只调用一次并成功重试。
6. 验证真实失败场景不会在日志、UI 或 Tool 结果泄漏 Token。
7. 没有真实账号和真实 OpenList 服务证据时，不得声称生产验收完成。

## 16. 完成标准

- 配置页只要求 OpenList URL 与 refresh token。
- 默认中国大陆节点正确，可完整自定义两个 URL。
- 运行时没有本地提前刷新窗口。
- OpenList 调用只发生于首次配置或阿里明确拒绝 access token 后。
- 限流、短冷却、reauth 状态跨重启有效。
- 新旧凭证代码不存在双模式分支。
- 文件数据不经过 OpenList。
- 全量自动化与独立验收门有可复核证据。
