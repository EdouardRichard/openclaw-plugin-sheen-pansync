# OpenClaw Pan Sync Helper 全功能全流程验收记录

## 结论

**PASS**。本次范围内的自动化、隔离安装、当前 OpenClaw 安装、真实授权、真实上传、重启恢复、配置页双语和敏感信息边界均已通过。真实限流按批准范围不执行；未删除任何远端验收文件。

## 受测版本与环境

- 源码基线提交：`855a0374ca64ec49ccd100df690d1773c27d9c5b`
- 隔离 worktree：`codex/full-flow-acceptance`
- 仓库验证 Node：`22.23.1`
- 当前 OpenClaw 运行 Node：`24.18.1`
- OpenClaw：`2026.7.1-2`
- 插件：`openclaw-pan-sync-helper 0.1.0`
- 未提交、未推送、未创建 PR、未发布。

## 最终候选包

- 文件：`openclaw-pan-sync-helper-0.1.0.tgz`
- SHA-256：`f0e1a253870ac483ed855fcd45ba3c1b6141c256fe89940fa24e4c22c25a806b`
- 大小：66,872 字节
- 条目：84
- 必需内容：`dist`、`ui`、`skills`、插件清单、阿里云授权指南均存在。
- 禁入内容：`src`、`tests`、`node_modules`、验收产物目录、环境文件、主密钥和加密凭据均不存在于包内。
- 当前 OpenClaw 安装来源指向该确切候选包。

## 自动化门禁

| 门禁 | 结果 |
|---|---|
| TypeScript 类型检查 | PASS |
| 单元测试 | 227 通过，1 个 Windows 不适用项跳过，0 失败 |
| 集成测试 | 105/105 通过 |
| 配置页/本地服务集成 | 39/39 通过 |
| 独立泄漏测试 | 27/27 通过 |
| 构建 | PASS |
| `npm pack --dry-run` | PASS，84 文件 |
| `git diff --check` | PASS |
| 最终 `npm run verify` | 退出码 0 |

## 隔离与当前实例安装

- 隔离状态中插件完成加载、启用和激活；Tool、CLI、HTTP route、service 和 Skill 注册完整。
- 当前实例使用全局 OpenClaw CLI 从最终候选包安装。
- Gateway 重启后健康检查为 `OK`。
- 插件诊断为空；`pan_sync_upload`、`pan-sync`、1 个 HTTP route、1 个 service 和 `pan-sync-upload` Skill 均存在。
- `tools.profile` 保持 `coding`，仅通过 `tools.alsoAllow` 精确增补 `pan_sync_upload`，未放行整个插件组。

## 真实授权与凭据边界

- 本地一次性配置页完成真实 OpenList 验证，页面返回 `SAVED_AND_VERIFIED`。
- 配置服务仅监听 IPv4 loopback，并在到期或结束后关闭。
- 凭据文件只记录元数据：`master.key` 32 字节，`credentials.enc` 1,515 字节；未读取其内容。
- Windows ACL 继承项仅包含 SYSTEM、Administrators 和当前用户。
- Gateway 重启和插件重装后无需重新输入凭据。
- 页面、Tool 结果、候选包、验收记录和受检有界输出中未出现 Token、完整配置 URL、一次性 fragment 或签名上传 URL。

## 配置页中英文验收

- 默认语言：简体中文，`html.lang=zh-CN`。
- 默认标题：`Pan Sync Helper 配置`；标题、风险提示、字段、链接、按钮、说明和状态均为中文。
- 页面提供可见 `中文 / English` 切换；切换后 `html.lang=en` 且全部文案为英文。
- Ready 显示为本地化描述并保留原始 `READY`。
- 7 类安全错误均显示本地化说明并保留原始错误码。
- 切换前后 Refresh Token 输入长度一致；自动化测试进一步验证精确值不变，且值不进入正文或控制台。
- 切换语言不触发 API 请求、不持久化语言、不修改 CSP，也不使用 `innerHTML`。

## 真实上传与意图路由矩阵

远端基准目录为 `/openClawShare`；本次验收使用独立运行子目录。未记录远端 ID、链接或签名 URL。

| 用例 | 结果 | 有界证据 |
|---|---|---|
| 英文明确上传 | PASS | `small-en.txt`，53 字节，Tool 调用 1 次 |
| 中文明确上传与 Unicode 文件名 | PASS | `验收-small-cn.txt`，56 字节，Tool 调用 1 次 |
| 同名保护 | PASS | 第二次解析为 `small-en(1).txt`，原文件未覆盖 |
| 41 MiB 多分片 | PASS | `multipart-41m.bin`，42,991,616 字节；修复后唯一重试成功 |
| 部分成功 | PASS | `small-en(2).txt` 成功；`missing.txt` 返回原始 `FILE_NOT_FOUND`；整体 `partial` |
| 纯讨论意图 | PASS | Agent Tool 调用列表为空，`pan_sync_upload` 为 0 |
| Gateway 重启后上传 | PASS | `restart-probe.txt`，63 字节，无需重新授权 |

当前远端共保留 6 个验收对象，总计 42,991,894 字节。按授权范围未执行远端删除。

## 故障发现与修复

### 一次性配置页显示 `REQUEST_FAILED`

- 根因：首次页面超过 10 分钟安全有效期，本地服务已关闭。
- 证据：监听与进程归零，凭据文件尚未生成，未发生外部保存请求。
- 处理：启动新的一次性配置会话后真实保存成功；未修改该安全到期机制。

### Agent 看不到插件 Tool

- RED：真实 Agent 返回 `Tool pan_sync_upload not found`，明确指出 `coding` profile 过滤。
- 根因：插件已注册，但当前 OpenClaw Tool 策略未增补第三方 Tool。
- 修复：只设置 `tools.alsoAllow=["pan_sync_upload"]` 并重启验证。
- GREEN：后续真实 Agent 均可调用 Tool，纯讨论会话仍为 0 次调用。

### 多分片上传失败

- RED：真实 41 MiB 请求返回原始 `UPLOAD_FAILED`，且没有远端对象。
- 根因：实现声明 `parallel_upload: true` 并并发 PUT 三个分片，却没有并行 SHA 上下文；普通 PDS 分片要求按序上传。
- 测试 RED：请求仍为并行标志、最大 PUT 并发为 3。
- 修复：`parallel_upload: false`，保留 64 KiB 流式读取并按 `part_number` 顺序 PUT；不增加网络重试。
- 测试 GREEN：14/14 Aliyun 上传测试通过，最大 PUT 并发为 1，事件严格按 start/end 顺序。
- 真实 GREEN：修复后唯一一次 41 MiB 重试成功，精确大小 42,991,616 字节。

### 配置页缺少中文

- RED：页面仍为 `lang=en`、英文静态文案和原始 `READY`。
- 修复：固定中英文词典、中文 HTML 回退、可访问语言切换、本地化状态/错误说明；原始码与 API/Tool 结构不变。
- GREEN：配置页 39/39、泄漏 27/27，并完成真实浏览器中文默认与英文切换验收。

## 外部失败策略验证

| 场景 | 方法 | 结果 |
|---|---|---|
| 网络不可用/超时/5xx | 本地确定性模拟 | PASS，映射为有界错误且不泄漏原始响应 |
| 授权拒绝/撤销 | 本地确定性模拟 | PASS，状态和错误码稳定；未破坏真实凭据 |
| 429/冷却/重启恢复 | 本地确定性模拟 | PASS，单飞与持久化冷却覆盖 |
| 真实限流 | 不执行 | 按用户批准范围跳过，避免 OpenList/阿里 IP 风险 |

## 未执行项与保留状态

- 真实限流压测：不适用，本次明确禁止。
- 远端验收文件删除：不在授权范围，未执行。
- Git commit/push/PR/publish：不在授权范围，未执行。
- 本地安全备份保留到用户验收完成；未读取或写入报告。

## 最终判定

所有适用硬门均为 PASS；只有明确不适用或未授权的真实限流、远端删除和版本控制发布操作未执行。最终候选包可在当前已验证的 OpenClaw 环境中交付使用。
