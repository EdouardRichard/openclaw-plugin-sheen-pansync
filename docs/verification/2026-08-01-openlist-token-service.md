# OpenList Token Service 验收记录（2026-08-01）

验证基线：`063888e7e9bf1aebbc2bc11e8560081bf716163a`。Node.js 固定为 `22.23.1`，OpenClaw 为 `2026.7.1-2 (0790d9f)`。本记录不包含一次性 fragment key、动态端口、Token、原始配置、临时根目录、真实账号标识或远端文件 ID。

## Automated gate — PASS

执行命令及退出码：

```powershell
volta run --node 22.23.1 npm ci --no-audit --no-fund  # exit 0
volta run --node 22.23.1 npm run verify               # 首次 exit 1；fresh 复跑 exit 0
volta run --node 22.23.1 npx vitest run tests/integration/package.test.ts --reporter=verbose  # exit 0
volta run --node 22.23.1 npm run test:integration     # exit 0
git diff --check                                      # exit 0
git status --short                                    # 仅未跟踪 dist/、node_modules/ 与本验收记录
```

fresh 完整门禁结果：

- typecheck：PASS；
- unit：13 test files，215 passed，1 skipped（216 total）；唯一跳过项是仅在 Linux 运行的 FIFO 无阻塞拒绝用例，当前主机为 Windows；
- integration：8 test files，100 passed；
- 合计：21 test files，315 passed，1 intentional platform skip；
- build：PASS；
- `npm pack --dry-run`：PASS，80 files。

首次完整运行在 `tests/integration/package.test.ts` 的官方插件安装步骤出现一次非确定性退出 1；当次 unit 为 215 passed / 1 skipped，integration 为 99 passed / 1 failed。该断言未保留 CLI stderr。随后同一安装命令手工退出 0，聚焦文件 6/6 passed，完整 integration 100/100 passed，fresh `npm run verify` 再次全部通过。未确认可稳定复现的产品缺陷，因此未修改源代码或测试；此冷启动/并行波动保留为关注项。

## OpenClaw installed-package smoke — PASS

实际 tarball 安装到私有 OpenClaw state/config 根，未使用仓库源码入口代替安装包：

```powershell
volta run --node 22.23.1 node node_modules/openclaw/openclaw.mjs plugins install $tarball
volta run --node 22.23.1 node node_modules/openclaw/openclaw.mjs plugins enable pan-sync-helper
volta run --node 22.23.1 node node_modules/openclaw/openclaw.mjs plugins inspect pan-sync-helper --runtime --json
volta run --node 22.23.1 node node_modules/openclaw/openclaw.mjs plugins doctor
volta run --node 22.23.1 node node_modules/openclaw/openclaw.mjs --no-color pan-sync configure
```

- install、enable、inspect、doctor 均 exit 0；`plugins doctor` 报告无插件问题；
- runtime inspect 显示插件 loaded、enabled、activated，diagnostics 为 0；
- `pan_sync_upload` 已注册，`pan-sync` CLI、1 个 HTTP route 与插件 service 均已注册；
- `pan-sync configure` 到达 readiness；OS socket 仅有一个 `127.0.0.1` listener，无 `0.0.0.0` 或 IPv6 wildcard listener；
- 从实际安装入口注册并调用只读 Control UI route：HTTP 200，`Cache-Control: no-store`，页面包含 `Token service: OpenList`，不包含 Refresh Token、Access Token、授权页 URL 或刷新 API URL 字段；
- 验收结束后精确停止临时进程，相关 listener 剩余 0。

## Browser acceptance — FAIL

使用 Codex in-app Browser 对实际安装包中的 setup server、UI 与 Provider 进行交互；OpenList/Aliyun 网络边界替换为仅回环的确定性假服务，未触达真实账号。未拍摄或保存含完整字段值的截图。

已通过的浏览器子项：

- 页面恰有 3 个 input：2 个 URL 字段与 1 个 Refresh Token 字段；
- 首次加载为中国区默认授权页与刷新 API URL；
- 无 Client ID、Client Secret 或 Access Token input；
- 编辑授权页 URL 后，授权链接同步更新；
- 保存并验证成功，3 个保存值均完整回显；
- 初始 fragment 从地址栏移除，同一 tab reload 后 session 授权仍有效；
- 保存后 reload 再次完整回显 3 个保存值，状态为 `READY`。

未完成的浏览器子项：

- `pagehide` 瞬间清空 3 个字段：NOT RUN。普通离开后返回会重新加载并从服务端重新投影保存值，不能作为瞬时清空证据；尝试以浏览器开发者事件只记录布尔值时被浏览器 URL 安全策略明确阻止，且策略禁止绕过。fresh integration 中已有确定性用例覆盖 `pagehide` 清值、请求 abort 与 fragment/session 行为，但自动化证据不替代本浏览器子项。

由于简报要求的浏览器矩阵未全部取得实际浏览器证据，本节不能标为 PASS。

## Real OpenList/Aliyun account acceptance — NOT RUN

本轮没有用户提供的真实阿里云盘账号授权或 Refresh Token，也没有获准对真实 OpenList/Aliyun 服务写入。以下均未运行：

1. 从官方中国区授权页获取 Refresh Token；
2. 通过安装包页面保存真实凭证；
3. 向 `/openClawShare` 上传唯一命名的无害文件并核对名称、大小；
4. 使用有效 Access Token 的第二次操作不发起 OpenList 刷新；
5. 安全的显式 Access Token 过期场景。

确定性 integration 覆盖刷新、持久化 cooldown、有效 token 不额外刷新与过期恢复路径，但不把这些自动化结果转换为真实账号 PASS。

## Package contents — PASS

实际制品：`openclaw-pan-sync-helper-0.1.0.tgz`。

- npm pack file count：80；
- tar entry count：80；
- SHA-256：`4b6dbb69b8c4140ba6ca15fba6a3546193c9fc565ce1d194eaf4cc6d8b80d7b3`；
- package path violations：0；
- 未包含 `.superpowers/`、`node_modules/`、`src/`、`tests/`、`plugin-data/`、嵌套 `dist/ui/` 或 `dist/skills/`；
- 必需 runtime、CLI、manifest、UI、Skill 与 README 均由 package integration gate 验证存在。

`dist/`、`node_modules/` 与实际 tarball 均未暂存或提交。

## Security and leakage — PASS

- integration leakage gate：27/27 passed；
- tarball 中验收假 Token、临时根标识、个人绝对路径与测试 CANARY 残留文件数：0；
- package UI 中 legacy Client ID/Secret/Access Token 字段残留文件数：0；
- `.env`、`master.key`、`credentials.enc` 等私有状态文件数：0；
- Control UI installed-entry probe 未返回 Token 或两个配置 URL；
- 文档未记录一次性 key、动态端口、Token、原始配置、真实服务响应或账号标识。

## Remaining blockers — FAIL

- 真实 OpenList/Aliyun 账号矩阵没有用户授权，必须保持 NOT RUN；
- `pagehide` 清值没有取得实际浏览器瞬时证据，浏览器节保持 FAIL；
- 首次并行完整验证出现一次官方安装退出 1，虽然后续四个相关门禁均通过，仍应在后续冷启动/CI 运行中关注。

## Release verdict — FAIL

**BLOCKED。** 自动化门禁、安装包 smoke、package contents 与 security/leakage 均通过，但真实账号验收为 NOT RUN，且浏览器 `pagehide` 子项缺少实际浏览器证据。不得根据本记录发布、merge、push 或创建 PR。
