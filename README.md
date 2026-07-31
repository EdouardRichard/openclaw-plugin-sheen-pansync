# OpenClaw Pan Sync Helper

## 1. 解决的问题

Pan Sync Helper 让 OpenClaw 将当前工作区中已经存在的普通文件上传到一个阿里云盘账户。它只在用户明确要求“上传”“同步”或“推送”文件时调用上传工具；它不会猜测或上传目录、特殊文件或工作区外的路径。

v1 只支持一个阿里云盘账户，默认上传目录是 `/openClawShare`，同名文件会自动重命名而不会覆盖已有文件。

## 2. 要求与安装

需要：

- Node.js `>=22.22.3`；
- OpenClaw `>=2026.7.1-2`；
- 一个由你注册的阿里云盘开放平台 OAuth 应用，以及该应用的 Client ID、Client Secret 和初始 Refresh Token。

从已发布的 npm 包安装：

```bash
openclaw plugins install openclaw-pan-sync-helper
```

从本地源码检出安装时，先构建，再把该目录交给 OpenClaw：

```bash
npm install
npm run build
openclaw plugins install .
```

安装命令会注册并启用插件。插件只接受普通插件配置中的 `defaultDirectory`（默认 `/openClawShare`）和可选的 `tokenGuideUrl`；凭证不写入普通插件配置。

## 3. 注册阿里云盘开放平台应用

在阿里云盘开放平台以自己的账户创建 OAuth 应用，并妥善保存该应用的 Client ID 与 Client Secret。不要使用他人、公共或工具默认提供的 OAuth 客户端。

接下来取得的 Refresh Token 必须由**同一个** OAuth 应用签发。三项值混用时，插件的“保存并验证”会失败，且不会覆盖已有的有效凭证。

## 4. 使用同一自定义 Client ID/Secret 获取初始 Refresh Token

初始 Refresh Token 可以通过可信、支持自定义 OAuth 客户端的工具获得。AList 的说明见 [Aliyundrive Open 自定义 Client ID/Secret 文档](https://alist-repo.github.io/docs/guide/drivers/aliyundrive_open.html)：在 AList 中使用自己的 Client ID 和 Client Secret 时，也必须用这同一应用取得 Refresh Token。

不要使用 AList 的公共/默认客户端模式，也不要使用公共 Token 获取或刷新服务。AList 在这里仅可作为取得初始 Token 的工具；插件运行时不依赖 AList。

完整核对以下三项都属于同一个 OAuth 应用后再继续：

```text
Client ID
Client Secret
Refresh Token
```

更多操作细节见 [初始 Refresh Token 指南](docs/guides/aliyun-token.md)。

## 5. 运行 `openclaw pan-sync configure`

在运行 OpenClaw 的主机上执行：

```bash
openclaw pan-sync configure
```

命令启动一个只监听 `127.0.0.1` 的一次性配置页，最长可用 10 分钟，并打印带一次性访问密钥的 `Remote URL`。在本机浏览器打开该 URL，录入三项值并选择“Save and verify”。

`client_secret` 与 `refresh_token` 的完整值只会在这个经授权的一次性回环配置页中显示；它们不会出现在 Control UI、上传工具结果、日志或错误信息中。

## 6. 远程 Linux 的 SSH 端口转发示例

先在远程 Linux 的 OpenClaw 主机运行 `openclaw pan-sync configure`。它会打印一个端口号与如下命令格式：

```bash
ssh -L <port>:127.0.0.1:<port> user@linux.example.com
```

在你的本地电脑建立该 SSH 隧道后，在本地浏览器打开远程命令打印的 `Remote URL`。不要把配置页改为监听 `0.0.0.0`，也不要把它直接暴露到网络。

## 7. 保存、验证凭证并测试上传

“Save and verify”会使用候选三项凭证直接访问阿里云盘官方端点，验证账户并加密保存成功的凭证。之后可选择“Test upload”：插件会通过正常上传流程创建一个小测试文件，并在页面显示其远程文件名和目录。

插件运行时会直接向阿里云盘官方端点刷新令牌并轮换新的 Token；它没有 AList 运行时依赖，也不会调用公共刷新服务。若授权被撤销、Refresh Token 被拒绝或三项值不匹配，请重新取得同一自定义 OAuth 应用的初始 Token，再运行配置命令。

## 8. 对话示例

下列明确的文件推送请求可以触发上传：

```text
把 report.pdf 推送到阿里网盘
把刚生成的结果上传到 aliyun
生成报告并把结果推送到网盘
```

第三个例子会先生成报告，确认文件确实存在后才上传。相反，`网盘里一般放什么文件？` 只是咨询，**不得触发上传**。

## 9. 安全模型与恢复

- 凭证保存为加密记录；状态页只显示脱敏的 Client ID、账户摘要和连接状态。
- 一次性配置页使用回环地址、限时访问和严格的浏览器安全策略。屏幕共享、浏览器扩展和主机管理员仍可能看到该页的完整凭证，因此请在可信环境中使用。
- 不要把 Client Secret、Refresh Token、配置 URL 或截图发给他人。
- 如果凭证泄露、失效或授权被撤销，请在阿里云盘侧撤销该应用授权，重新获取同一自定义 OAuth 应用的新 Refresh Token，再通过 `openclaw pan-sync configure` 保存并验证。

有关外部 Web 获取流程的安全边界，见 [独立 Token 获取 Web 系统计划](docs/plans/token-acquisition-web-system.md)；该计划不是本插件的一部分。

## 10. v1 已知限制

- 仅支持一个阿里云盘账户和 `aliyun` Provider。
- 不提供二维码登录、插件内 OAuth 回调、公共 Token 中转或公共刷新服务。
- 不提供 AList 运行时依赖、文件代理或多网盘实现。
- Control UI 只提供脱敏状态，不提供完整凭证编辑；完整凭证仅能在一次性回环配置页中操作。
- 不把真实账户上传验收等同于自动化测试或打包检查；它们是独立的交付验证。
