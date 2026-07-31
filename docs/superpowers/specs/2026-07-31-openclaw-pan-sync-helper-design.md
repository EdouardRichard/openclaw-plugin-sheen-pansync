# OpenClaw Pan Sync Helper 设计

- 日期：2026-07-31
- 状态：审核通过
- 第一版网盘：阿里云盘 OpenAPI
- 插件形态：OpenClaw 原生 TypeScript ESM 混合能力插件（Tool + Control UI）

## 1. 背景

OpenClaw 部署在远程 Linux 主机时，生成文件位于远程工作区，用户获取文件不方便。本插件为 OpenClaw 增加“将工作区文件推送到网盘”的能力。

第一版接入阿里云盘，同时把网盘差异封装在 Provider 边界内，后续新增其他网盘时不修改上传编排、凭证存储和 Agent Tool 协议。

## 2. 已确认的产品决策

1. 每个 OpenClaw 实例第一版只配置一个阿里云盘账号。
2. 插件不实现二维码登录、OAuth 回调或 Token 获取。
3. 用户自行注册阿里云盘开放平台应用，取得 `client_id` 和 `client_secret`。
4. 用户可通过 AList 等支持“自定义客户端凭证”的第三方工具取得初始 `refresh_token`。
5. `client_id`、`client_secret` 与 `refresh_token` 必须属于同一个 OAuth 应用。
6. 初始配置完成后，插件直接调用阿里云盘官方接口刷新 Token，不依赖第三方刷新服务。
7. 配置页完整回显 `client_secret` 和 `refresh_token`，方便用户核对录入内容。
8. 默认网盘为阿里云盘，默认上传目录为 `/openClawShare`。
9. 用户明确指定“阿里网盘”“阿里云盘”“aliyun”或“alipan”时使用阿里云盘。
10. 用户未指定网盘但明确要求把结果推送、上传或同步到网盘时，使用默认网盘。
11. 文件数据由 OpenClaw 主机直接发送到阿里云盘，不经过第三方 Token 工具或计划中的 Token 获取 Web 系统。

## 3. 目标

### 3.1 用户目标

- 在 OpenClaw 对话中要求上传已有文件。
- 在生成结果文件的同一请求中要求自动推送到网盘。
- 未配置凭证时获得明确的配置引导。
- 通过插件提供的一次性回环地址配置页录入、验证、查看、替换和清除阿里云盘凭证，并在 Control UI 查看脱敏状态。
- OpenClaw 重启后继续保持登录。

### 3.2 工程目标

- 使用稳定、窄小的 Provider 接口隔离网盘实现。
- 令牌自动刷新、轮换和持久化。
- 限制插件只能读取当前 OpenClaw 工作区中的普通文件。
- 所有错误使用稳定错误码，不泄露 Token、完整本地路径或官方原始响应。
- 发布包包含编译后的 ESM 代码、Manifest、Skill 和测试。

## 4. 非目标

第一版不包含：

- 插件内二维码登录。
- OAuth 回调服务。
- 公共 Token 中转或刷新服务。
- 多阿里云盘账号。
- 百度、夸克等其他网盘的实际 Provider。
- 目录自动压缩上传。
- 文件下载。
- 双向同步。
- 文件系统自动监听。
- 自动生成公开分享链接。
- 使用 AList 公共应用签发的 Token。
- 使用 AList 公共 Token 刷新服务。

## 5. 总体架构

插件由六个边界清晰的模块组成：

1. **Agent Tool 与 Skill**
   - 向模型暴露 `pan_sync_upload`。
   - 定义对话触发语义、参数约束和调用时机。

2. **Upload Orchestrator**
   - 解析 Provider、验证路径、组织刷新、创建远程目录并上传。
   - 汇总逐文件结果。

3. **Provider Registry**
   - 注册并解析具体网盘 Provider。
   - 第一版只注册 `aliyun`。

4. **Aliyun Provider**
   - 实现官方 Token 刷新、账号验证、目录查找或创建、文件上传。
   - 封装阿里云盘协议、限流和错误映射。

5. **Credential Vault**
   - 加密保存应用凭证、用户令牌和账号摘要。
   - 提供原子替换、凭证版本检查、进程内刷新锁和 OpenClaw 跨进程 state lease。

6. **管理界面**
   - Control UI 提供脱敏连接状态、上传设置摘要和配置命令指引。
   - 一次性回环地址配置页提供完整凭证配置、验证、清除和测试上传。
   - Control UI 可见性受 OpenClaw Operator 权限控制；完整凭证页受本机回环地址、SSH 隧道和一次性访问密钥控制。

数据流：

```text
用户对话
  -> OpenClaw Agent
  -> pan_sync_upload
  -> Upload Orchestrator
  -> Workspace Path Guard
  -> Token Manager
  -> Aliyun Provider
  -> 阿里云盘 OpenAPI
```

## 6. OpenClaw 插件集成

### 6.1 包结构

插件使用 `definePluginEntry` 注册 Tool、Control UI、HTTP 路由、CLI 和服务生命周期。它不是只能注册工具的 `defineToolPlugin` 纯 Tool Plugin。第一版不注册凭证写入 Gateway 方法，因为当前外部插件 iframe 没有安全的写调用桥接。

运行要求：

- Node.js 22.22.3+、24.15+ 或 25.9+。
- OpenClaw `>=2026.7.1-2`。
- 发布包包含 `dist/`。
- `package.json` 同时声明源码入口和运行时入口。
- 根目录包含有效的 `openclaw.plugin.json`。

#### 6.1.1 CLI metadata 兼容入口

OpenClaw `2026.7.1-2` 在解析插件 CLI 命令时优先加载包根目录的
`cli-metadata.js`，并为社区插件提供 `registrationMode: "cli-metadata"`、空的
`runtime` 对象和 `registerCli` 能力。该阶段不能访问完整插件运行时，也不能调用
`api.runtime.state.resolveStateDir()`。

本插件采用独立的轻量 CLI metadata 入口：

- 发布包根目录必须包含 `cli-metadata.js`，它只注册 `pan-sync` 命令元数据，不初始化
  Tool、HTTP 路由、Control UI、Provider 或凭证存储。
- 用户实际执行 `pan-sync configure` 时，命令处理器再延迟导入 `dist/` 中的 CLI
  运行时模块。
- CLI 运行时通过 OpenClaw 公共导出
  `openclaw/plugin-sdk/state-paths` 的 `resolveStateDir()` 定位 state 目录；不得依赖
  metadata 上下文中不存在的 `api.runtime.state`，也不得访问 OpenClaw 私有 loader。
- 完整插件入口和 CLI 入口复用同一个运行时组合函数，保证 Credential Store、SQLite
  lease、Token Manager、Aliyun Provider、Provider Registry 和 Upload Orchestrator 的
  构造规则一致。
- `cli-metadata.js` 必须进入 npm 发布白名单；源码、测试、临时 OpenClaw state 和凭证
  文件仍不得进入发布包。

曾评估的替代方案包括：让完整 `dist/index.js` 在 metadata 模式下跳过部分注册，或在
CLI metadata 阶段伪造完整 runtime。前者仍会把重量级运行时加载进命令发现流程，并
容易产生两套条件注册逻辑；后者依赖未承诺的私有契约。独立轻量入口边界最清晰，且与
OpenClaw 官方 CLI metadata 加载方式一致，因此作为本版本方案。

### 6.2 Control UI 页面

插件使用分组后的 SDK 接口注册 Control UI 标签页：

```text
api.session.controls.registerControlUiDescriptor(...)
```

页面由同一插件的 Gateway HTTP 路由提供：

```text
api.registerHttpRoute({ auth: "gateway", ... })
```

标签页只对具有 `operator.write` 的管理者显示。

经对 OpenClaw `2026.7.1-2` 源码契约复核，外部插件标签页运行在沙箱 iframe 中，Gateway 只向该 iframe 发放短期、只读、仅限 `GET/HEAD` 的授权；当前没有把插件专属 `operator.write` Gateway 方法安全桥接给外部 iframe 的公开 SDK。因此本版本不能在该 iframe 中直接保存、完整读取或清除凭证，否则会把凭证写入降级为只读授权、URL Token 或自建弱认证，违背本设计的权限边界。

第一版采用以下兼容方案：

- Control UI 标签页只展示脱敏连接状态、默认目录、配置指引和本机配置命令，不返回完整凭证。
- 插件提供 `openclaw pan-sync configure` 命令。命令仅监听远程主机 `127.0.0.1`，启动一个有时限的一次性配置页面；远程用户通过 SSH 端口转发访问。
- 一次性页面访问密钥放在 URL fragment 中，不进入 HTTP 请求、服务端日志或 Referer；前端读取后立即从地址栏移除，并通过专用 Authorization 请求头提交。
- 完整 `client_secret` 和 `refresh_token` 只在该一次性配置页面中回显。页面保存、验证、清除或超时后停止监听。
- 后端 Credential Vault、Token Manager 和 Provider 接口与 UI 传输方式解耦。OpenClaw 后续提供受 `operator.write` 保护的外部标签页写桥接后，可以替换为原生 Control UI 配置表单，而不修改凭证格式或上传流程。

插件 HTTP 页面只包含本地静态资源，不加载 CDN、统计脚本、第三方字体、图片或 iframe。

### 6.3 Agent Tool

工具名称：

```text
pan_sync_upload
```

输入：

```ts
type PanSyncUploadInput = {
  paths: string[];
  provider?: "aliyun";
  remoteDirectory?: string;
};
```

输出：

```ts
type PanSyncUploadResult = {
  provider: string;
  remoteDirectory: string;
  status: "success" | "partial" | "failed";
  files: Array<{
    inputName: string;
    remoteName?: string;
    size?: number;
    status: "uploaded" | "failed";
    errorCode?: string;
  }>;
};
```

工具不返回 Access Token、Refresh Token、Client Secret、完整本地绝对路径、内部调用栈或未经处理的官方响应。

### 6.4 随包 Skill

插件随包发布一个 Skill，Manifest 列出 Skill 目录。Skill 指导模型：

- 文件生成完成并确认存在后再调用上传工具。
- “阿里网盘”“阿里云盘”“aliyun”“alipan”映射到 `aliyun`。
- 用户只说“网盘”但明确表达上传、同步或推送动作时，使用默认 Provider。
- 仅出现“网盘”名词而没有上传意图时不调用工具。
- 不猜测不存在的文件路径。
- 一次用户请求中的同一文件不重复上传。

## 7. Provider 设计

Provider 接口：

```ts
interface CloudDriveProvider {
  readonly id: string;
  readonly aliases: readonly string[];

  validateCredentials(
    credentials: ProviderCredentials,
  ): Promise<AccountSummary>;

  refreshCredentials(
    credentials: ProviderCredentials,
  ): Promise<RefreshedCredentials>;

  ensureDirectory(
    remotePath: string,
    accessToken: string,
  ): Promise<RemoteDirectory>;

  uploadFile(
    input: UploadFileInput,
  ): Promise<UploadResult>;
}
```

第一版 Registry：

```text
id: aliyun
aliases:
  - 阿里网盘
  - 阿里云盘
  - aliyun
  - alipan
```

新增网盘时只新增 Provider、凭证表单定义和触发别名，不改变 `pan_sync_upload` 的核心语义。

## 8. 阿里云盘凭证与 Token 刷新

### 8.1 凭证来源

用户必须提供：

- `client_id`
- `client_secret`
- `refresh_token`

用户可以使用 AList 等第三方工具获取初始 Refresh Token，但必须选择第三方工具的“使用自己的客户端 ID 和密钥”方式。

如果 Refresh Token 由其他 OAuth 客户端签发，插件保存验证必须失败，且不得覆盖当前有效凭证。

### 8.2 保存验证

“保存并验证”按以下顺序执行：

1. 检查三项字段非空和格式上限。
2. 使用候选三项凭证调用官方刷新接口。
3. 使用新 Access Token读取账号摘要。
4. 构造新的完整凭证记录。
5. 加密写入临时文件。
6. 同步文件并原子替换当前凭证文件。
7. 更新内存快照。

任何一步失败都保留旧凭证。

### 8.3 自动刷新

触发刷新条件：

- 没有可用 Access Token。
- Access Token 剩余有效期不足 5 分钟。
- 官方接口返回一次明确的 Access Token 过期错误。

刷新规则：

- 同一进程只允许一个刷新请求运行，Gateway 与配置 CLI 的持久化操作通过同一个 OpenClaw state lease 协调。
- 并发上传等待同一个刷新结果。
- 使用凭证版本号防止旧请求覆盖新 Token。
- 新 Refresh Token 成功加密落盘后才更新内存快照。
- 401 或等价过期错误最多刷新并重试一次。
- 不进行固定频率的后台刷新。
- 网络失败保留旧凭证并进入 `DEGRADED`。
- `invalid_grant`、授权撤销或 Refresh Token 被拒绝时进入 `REAUTH_REQUIRED`。

### 8.4 状态机

```text
UNCONFIGURED
  -> VALIDATING
  -> READY
  -> REFRESHING
  -> READY

临时网络或服务失败 -> DEGRADED
授权失效           -> REAUTH_REQUIRED
清除凭证           -> UNCONFIGURED
```

## 9. Credential Vault

### 9.1 文件布局

```text
plugin-data/
  master.key
  credentials.enc
```

Linux 权限：

- `plugin-data/`：`0700`
- `master.key`：`0600`
- `credentials.enc`：`0600`

### 9.2 加密内容

`credentials.enc` 包含：

- `client_id`
- `client_secret`
- `refresh_token`
- 当前 `access_token`
- Access Token 过期时间
- 脱敏账号摘要
- 凭证版本号
- 最近验证时间

使用 AES-256-GCM，并为每次写入生成新的随机 nonce。密文包含格式版本，便于未来迁移。

主密钥首次运行时使用加密安全随机数生成。丢失主密钥后不能恢复凭证，用户必须重新配置。

该方案防止普通配置泄露、误提交、备份中直接暴露明文以及其他系统用户读取，但不承诺抵御已取得 OpenClaw 进程权限或主机 root 权限的攻击者。

### 9.3 原子写入

写入步骤：

1. 在同一目录创建权限为 `0600` 的临时文件。
2. 写入完整密文并同步。
3. 原子替换 `credentials.enc`。
4. 必要时同步父目录元数据。

失败时保留原文件。

## 10. 管理界面设计

### 10.1 凭证区

凭证区位于 `openclaw pan-sync configure` 启动的一次性回环地址配置页面，不位于 OpenClaw 外部插件 iframe。Control UI 标签页只显示第 10.3 节的脱敏状态和打开配置页的命令指引。

字段：

- Client ID
- Client Secret
- Refresh Token

三个字段均完整回显，包括页面重新打开后读取当前保存值。输入框不使用密码遮罩，用户可以核对录入是否正确。

安全约束：

- Control UI 脱敏状态页要求 `operator.write`。
- 完整凭证页面仅监听 `127.0.0.1`，要求高熵、一次性、有时限的页面访问密钥；远程访问必须使用 SSH 端口转发。
- 响应包含 `Cache-Control: no-store`。
- 使用严格 CSP。
- 使用 `Referrer-Policy: no-referrer`。
- 表单关闭浏览器自动完成。
- 凭证不进入 URL、浏览器控制台、日志、遥测、对话或错误报告。
- 页面卸载时清空前端表单状态。
- 页面醒目提示屏幕共享、浏览器扩展和管理员可见完整凭证。

按钮：

- 保存并验证
- 重新验证
- 清除凭证

清除凭证需要二次确认，并清除磁盘与内存中的令牌。

### 10.2 上传设置区

- 默认网盘：第一版显示阿里云盘。
- 默认上传目录：初始值 `/openClawShare`。
- 同名策略：自动重命名。
- Token 指引 URL：可选。
- 测试上传。

未配置 Token 指引 URL 时，页面展示插件内置指南。内置指南说明：

1. 注册阿里云盘开放平台应用。
2. 使用支持自定义应用凭证的第三方 Token 工具。
3. 在第三方工具中输入自己的 Client ID 和 Client Secret。
4. 将同一组 Client ID、Client Secret 和获得的 Refresh Token 录入本页。

### 10.3 连接状态区

非凭证状态接口返回：

```json
{
  "provider": "aliyun",
  "configured": true,
  "status": "ready",
  "accountNameMasked": "用***户",
  "clientIdMasked": "12****89",
  "defaultDirectory": "/openClawShare",
  "lastVerifiedAt": "2026-07-31T10:00:00Z",
  "lastErrorCode": null
}
```

### 10.4 测试上传

测试上传：

1. 在插件临时目录生成一个很小的文本文件。
2. 通过正常 Upload Orchestrator 上传。
3. 删除本地临时文件。
4. 网盘端测试文件保留，并向用户显示远程文件名和目录。

## 11. 上传编排

### 11.1 本地路径安全

第一版支持一个或多个普通文件。

每个输入路径必须：

- 解析到当前 OpenClaw 工作区内部。
- 在解析符号链接后仍位于工作区内部。
- 存在且可读。
- 是普通文件。
- 不是目录、设备、FIFO、Socket 或其他特殊文件。

拒绝：

- `..` 逃逸。
- 绝对路径指向工作区外部。
- 符号链接逃逸。
- 上传期间被替换为特殊文件。

日志只记录脱敏文件名或哈希关联 ID，不记录完整绝对路径。

### 11.2 远程目录

- 默认 `/openClawShare`。
- 远程路径使用 POSIX 规则规范化。
- 拒绝空字节、控制字符和越过网盘根目录的路径。
- 目录不存在时逐级创建。
- 同一次运行缓存已解析目录 ID。

### 11.3 文件上传

- 小文件使用官方普通上传流程。
- 大文件使用官方分片上传流程。
- 不把完整文件读入内存。
- 文件内容直接发送到阿里云盘。
- 同名默认自动重命名，不覆盖已有文件。
- 单文件失败不回滚其他已成功文件。
- 逐文件返回结果。

## 12. 对话行为

示例：

```text
用户：把 report.pdf 推送到阿里网盘
行为：调用 aliyun Provider，上传 report.pdf。
```

```text
用户：把结果上传到 aliyun
行为：在结果文件存在后上传到 aliyun。
```

```text
用户：生成报告并将结果推送到网盘
行为：先生成报告文件，再使用默认 Provider 上传。
```

```text
用户：网盘里一般放什么文件？
行为：不调用上传工具。
```

未配置凭证时返回：

```json
{
  "code": "CREDENTIALS_REQUIRED",
  "provider": "aliyun",
  "message": "请在 Pan Sync Helper 配置页录入阿里云盘应用凭证。",
  "settingsPath": "/pan-sync-helper/settings"
}
```

本插件配置的是实例级单账号。任何获准调用该 Agent Tool 的聊天来源都会上传到同一个阿里云盘账号。允许哪些来源调用工具由 OpenClaw 的 Agent 与 Tool 策略控制。

## 13. 错误模型

稳定错误码：

- `CREDENTIALS_REQUIRED`
- `CREDENTIALS_INVALID`
- `REFRESH_TOKEN_REJECTED`
- `AUTHORIZATION_REVOKED`
- `TOKEN_ENDPOINT_UNAVAILABLE`
- `RATE_LIMITED`
- `WORKSPACE_PATH_REJECTED`
- `FILE_NOT_FOUND`
- `FILE_NOT_READABLE`
- `REMOTE_DIRECTORY_FAILED`
- `QUOTA_EXCEEDED`
- `UPLOAD_FAILED`
- `UPLOAD_PARTIAL`

原始上游错误先进入内部映射器，再输出稳定错误码和安全消息。

对话回复示例：

```text
已将 2 个文件上传到阿里云盘 /openClawShare。
另有 1 个文件上传失败：网盘空间不足。
```

## 14. 测试策略

### 14.1 单元测试

- Provider 注册与别名解析。
- 默认 Provider。
- 路径规范化和工作区逃逸阻止。
- 远程路径规范化。
- AES-256-GCM 加解密和篡改检测。
- 凭证文件原子替换。
- Refresh Token 版本控制。
- 并发刷新 single-flight。
- 错误映射与脱敏。
- 同名自动重命名。

### 14.2 协议测试

使用本地 Mock HTTP 服务覆盖：

- 正确凭证保存与首次刷新。
- 三项凭证不匹配。
- 验证失败保留旧凭证。
- Access Token 临近过期。
- 401 刷新并重试一次。
- 新 Refresh Token 落盘顺序。
- 429 退避。
- 网络超时。
- 授权撤销。
- 目录创建。
- 普通上传和分片上传。
- 配额不足和部分成功。

### 14.3 OpenClaw 集成测试

- Manifest、Config Schema 和编译产物。
- 实际 npm tarball 包含根级 `cli-metadata.js`，并排除源码、测试和运行时秘密。
- 将实际 tarball 安装到全新 OpenClaw state 后，官方
  `openclaw pan-sync configure` 能被识别并启动回环配置服务，不产生 CLI metadata
  注册诊断；测试必须精确终止服务且不得输出一次性 fragment 或凭证。
- `pan_sync_upload` 注册。
- 随包 Skill 发现。
- Control UI 标签页。
- Operator 权限。
- 凭证保存、完整回显、验证和清除。
- 未配置错误。
- 工作区路径限制。
- 重启恢复。
- 日志与会话 Token 泄露扫描。

### 14.4 真实账号人工验收

1. 注册专用阿里云盘测试应用。
2. 使用第三方工具的自定义客户端凭证模式取得 Refresh Token。
3. 在配置页录入并核对三项凭证。
4. 保存并验证账号。
5. 上传小文件到 `/openClawShare`。
6. 上传同名文件并确认自动重命名。
7. 上传多个文件并检查逐文件结果。
8. 使 Access Token 过期并确认自动刷新。
9. 重启 OpenClaw 后再次上传。
10. 验证中文与英文触发词。
11. 检查网盘、日志和对话记录。

自动化通过、真实账号验收和发布合规是三个独立交付门槛。

## 15. 外部 Token 获取 Web 系统规划

该系统不在本仓库实现。它是独立项目，目标是降低用户获取初始 Refresh Token 的难度。

### 15.1 功能范围

- 展示阿里云盘开放平台应用注册说明。
- 用户输入自己申请的 Client ID 和 Client Secret。
- 使用用户自己的应用发起 OAuth 授权。
- 校验 `state` 与回调。
- 使用同一组客户端凭证换取初始 Refresh Token。
- Token 只显示一次。
- 提供复制按钮和插件录入说明。
- 提供可自行部署的版本。

### 15.2 明确边界

- 不提供 Token 刷新 API。
- 不参与插件运行时。
- 不代理文件上传。
- 不保存用户网盘文件。
- 不使用平台公共 OAuth 应用替代用户自己的应用。

### 15.3 安全要求

- 全站 HTTPS。
- 严格回调地址校验。
- 高熵、一次性 `state`。
- 临时授权会话短时过期。
- Client Secret、授权码和 Token 不写日志。
- 禁止请求正文进入 APM、错误追踪和分析系统。
- Token 不持久化。
- 授权完成后清除服务端临时内存。
- CSP、CSRF 防护、速率限制和安全响应头。
- 页面明确说明托管服务在换取 Token 时会短暂接触 Client Secret。
- 高安全需求用户应使用自行部署版本或其他可信的本地工具。

### 15.4 与插件的契约

Web 系统只输出 Refresh Token。用户将以下三项录入插件：

```text
client_id
client_secret
refresh_token
```

插件保存时直接调用官方接口验证契约是否成立。

## 16. 交付物

- TypeScript ESM OpenClaw 原生插件。
- `openclaw.plugin.json`。
- 编译后的 `dist/`。
- 阿里云盘 Provider。
- `pan_sync_upload` Agent Tool。
- 随包对话触发 Skill。
- Control UI 脱敏状态页和一次性回环地址凭证配置页。
- Credential Vault。
- 自动刷新和上传编排。
- 自动化测试。
- 中文 README。
- 阿里云盘应用注册和第三方 Token 工具使用指南。
- 本文档中的外部 Token 获取 Web 系统规划。
- 可安装插件包。

## 17. 完成标准

第一版完成必须同时满足：

1. 所有自动化测试通过。
2. OpenClaw 能发现并加载已安装插件。
3. 管理者能保存、完整回显、验证和清除三项凭证。
4. 插件能自动刷新 Access Token 和轮换 Refresh Token。
5. 对话显式要求上传时能推送工作区文件。
6. 未指定 Provider 时使用默认阿里云盘。
7. 文件默认进入 `/openClawShare`。
8. 工作区逃逸测试全部被拒绝。
9. 日志和对话记录不出现完整 Token。
10. 使用专用真实账号完成手工验收。

## 18. 设计参考

- OpenClaw Building Plugins：<https://docs.openclaw.ai/plugins/building-plugins>
- OpenClaw Plugin SDK Overview：<https://docs.openclaw.ai/plugins/sdk-overview>
- OpenClaw Plugin Manifest：<https://docs.openclaw.ai/plugins/manifest>
- OpenClaw Plugin Setup and Config：<https://docs.openclaw.ai/plugins/sdk-setup>
- OpenClaw Plugins and Skills：<https://github.com/openclaw/openclaw/blob/main/docs/tools/skills.md#plugins-and-skills>
- OpenClaw Secrets Management：<https://docs.openclaw.ai/gateway/secrets>
- AList 阿里云盘 Open：<https://alist-v3.pages.dev/zh/guide/drivers/aliyundrive_open>
- AList 阿里云盘 Open 刷新实现：<https://github.com/AlistGo/alist/blob/aead76e49a8629edcd3032cc43489787b4b5b319/drivers/aliyundrive_open/util.go>
- OAuth 2.0 RFC 6749：<https://www.rfc-editor.org/rfc/rfc6749>
