# OpenClaw Sheen PanSync

[中文](#中文) | [English](#english)

## 中文

Sheen PanSync 让 OpenClaw 安全地上传、查找和下载网盘文件。当前只支持阿里云盘

## 插件用途

插件注册三个 Tool：

- `pan_sync_upload`：把当前 OpenClaw 工作区中已经存在的文件上传到阿里云盘。
- `pan_sync_list`：列出网盘目录，或按名称搜索文件。
- `pan_sync_download`：把一个普通文件下载到当前工作区，再由 OpenClaw 的常规文件能力读取、总结或处理。

上传默认目录是 `/openClawShare`，列出和搜索默认从资源盘根目录 `/` 开始，下载默认写入当前工作区根目录。插件不递归下载文件夹，也不会把网盘文件正文直接塞进 Tool 返回值。针对阿里云盘：所有文件下载、上传、列出均只针对**资源盘（resource drive）**

OpenList 只负责完成阿里云盘授权和刷新 Token；文件内容由插件直接与阿里云盘传输。Token 只能在十分钟临时配置页中提交并进入加密凭据存储，普通插件配置不接受 `refresh_token`。插件没有二维码登录或登录轮询功能。

运行前需要 Node.js `22.22.3` 或更高版本、OpenClaw `2026.7.1-2` 或兼容的更高版本。下载还要求当前 OpenClaw 会话具有可写工作区。

## 依赖 OpenClaw 自动安装

如果 OpenClaw 可以操作部署主机，把下面整段提示词复制给它。执行期间仍需由你在浏览器中完成 Token 填写，并在涉及云平台权限时确认操作。

### 可复制提示词：首次安装、配置与验证

```text
请帮我安装并配置 openclaw-plugin-sheen-pansync。先识别当前操作系统、Shell、OpenClaw 版本、插件状态、工作区和有效 Tool 策略；保留所有无关配置与用户改动。

优先使用 npm 安装并启用插件。先确认我明确请求或授权了上传、列出/搜索、下载中的哪些能力，只把对应的 Tool 合并到当前有效的全局或 Agent 级策略；保留其他策略条目和策略层。若显式 deny 阻止某个所需 Tool，报告该精确冲突及影响，取得我确认后才能移除那一个精确 deny，不能静默放行全部三个 Tool，也不要整体替换 allow、alsoAllow 或 deny。本轮若安装、启用插件或修改了 Tool 策略，必须先让在线 Gateway 加载变更：OpenClaw 托管安装执行 openclaw gateway restart --safe；非托管或容器部署重启实际承载 Gateway 的进程或容器。然后用 openclaw plugins list 只检查插件已安装且可见，再用 openclaw plugins inspect sheen-pansync --runtime --json 检查 runtime toolNames 包含 pan_sync_upload、pan_sync_list、pan_sync_download；runtime inspect 本身不代表在线 Gateway 已加载变更。

在后台启动 openclaw pan-sync configure，准确记录并持续跟踪你启动的配置进程 PID，读取命令实际输出的 Local URL、Remote URL 和端口。判断我是同机、局域网还是公网访问，并检查端口占用、主机防火墙、云安全组、NAT/端口映射及公网 IP。只能自动修改你能够确认和回滚的配置；若需要我操作云平台，请给出精确步骤并等待。云主机只有私网 Remote URL 时，使用实际公网 IP 替换 URL 主机部分，保留端口和 fragment。

把可用的十分钟临时配置 URL 发给我。不要让我把 refresh_token 发到对话中；提醒我只在配置网页中粘贴 Token。初始页面显示 READY 只表示临时页成功读取配置；成功保存候选凭据后应显示 SAVED_AND_VERIFIED。随后只在已认证的 Sheen PanSync 只读 Control UI 状态标签页确认持久凭据状态为 ready，再检查 runtime toolNames，并在新会话中通过 /tools 验证本轮明确授权的 Tool 实际可用。

最后只终止你在本轮亲自启动并持续跟踪了准确 PID 的临时配置进程；预先存在、PID 未跟踪或归属不确定的进程一律保留。只清理由本轮新增的主机防火墙、云安全组或端口映射规则，不要删除预先存在或来源不明的规则。报告自动化验证结果和仍需真实阿里云盘账号完成的验收，不要把两者混为一谈。
```

## 手动安装

先在 OpenClaw 主机上确认 Node.js 与 OpenClaw 版本符合上面的要求。以下 PowerShell 命令应在你准备安装插件的用户环境中执行。

### 使用 npm 安装

安装已发布的包、启用插件并检查注册结果：

```powershell
openclaw plugins install npm:openclaw-plugin-sheen-pansync
openclaw plugins enable sheen-pansync
openclaw gateway restart --safe
openclaw plugins list
```

上面的重启命令适用于 OpenClaw 托管的 Gateway。非托管或容器部署必须改为重启实际承载 Gateway 的进程或容器；不要用 runtime inspect 代替在线 Gateway 的加载门禁。`openclaw plugins list` 只能检查插件已经安装并且对 OpenClaw 可见；当前版本可能显示 `loaded`，它不证明三个 Tool 已完成 runtime 注册。继续检查 runtime 的 `toolNames`：

```powershell
openclaw plugins inspect sheen-pansync --runtime --json
```

输出的 `toolNames` 应包含 `pan_sync_upload`、`pan_sync_list` 和 `pan_sync_download`。最后新建一个 OpenClaw 会话并执行 `/tools`，确认本轮明确授权的 Tool 在当前有效策略下实际可用。

### 拉取仓库并构建安装

在一个准备存放源码的目录中执行：

```powershell
git clone https://github.com/EdouardRichard/openclaw-plugin-sheen-pansync.git
Set-Location openclaw-plugin-sheen-pansync
npm ci
npm run build
openclaw plugins install .
openclaw plugins enable sheen-pansync
openclaw gateway restart --safe
```

上面的重启命令适用于 OpenClaw 托管的 Gateway；非托管或容器部署必须重启实际承载 Gateway 的进程或容器。随后执行 `openclaw plugins list` 检查安装可见性，再执行 `openclaw plugins inspect sheen-pansync --runtime --json` 检查 runtime `toolNames`，最后在新会话中通过 `/tools` 检查本轮明确授权的 Tool 实际可用。runtime inspect 和源码测试都不能代替在线 Gateway 加载与新会话检查。

## 更新插件

### 手动更新

先预览 OpenClaw 将执行的变更，再更新被 OpenClaw 跟踪的安装：

```powershell
openclaw plugins update sheen-pansync --dry-run
openclaw plugins update sheen-pansync
openclaw gateway restart --safe
openclaw plugins list
openclaw plugins inspect sheen-pansync --runtime --json
```

`openclaw gateway restart --safe` 只适用于 OpenClaw 托管的 Gateway；非托管或容器部署应重启实际承载 Gateway 的进程或容器。更新后新建会话并执行 `/tools`，确认当前策略明确授权的三个 Tool 仍然可用。更新不需要重新填写 Token，也不应重置现有凭据、插件配置、Tool 策略或其他用户改动。

如果 `plugins update` 报告当前安装来源不受跟踪，应沿用原安装方式：npm 安装可运行 `openclaw plugins install npm:openclaw-plugin-sheen-pansync --force`；源码安装应先确认仓库没有未处理的本地改动，再拉取目标版本、执行 `npm ci` 和 `npm run build`，最后运行 `openclaw plugins install . --force`。不要为了更新而删除配置或凭据目录。

### 可复制提示词：自动更新与验证

```text
请帮我安全更新 Sheen PanSync。先检查操作系统、OpenClaw 版本、当前插件版本、安装来源、Gateway 承载方式、有效 Tool 策略和工作区状态；保留所有凭据、插件配置、Tool 策略、本地源码改动和无关用户文件，不要要求我提供 refresh_token。

先执行 openclaw plugins update sheen-pansync --dry-run 并向我说明预期变更，再执行 openclaw plugins update sheen-pansync。如果当前来源不受 update 跟踪，沿用原安装来源更新：npm 安装使用受支持的 npm 强制重装方式；源码安装先检查未提交改动，绝不能覆盖或丢弃它们，确认安全后再拉取、安装依赖、构建并强制重装。遇到版本、网络、权限或安装策略限制时报告真实错误，不要通过删除配置或凭据来绕过。

更新完成后，让在线 Gateway 加载变更：OpenClaw 托管安装执行 openclaw gateway restart --safe；非托管或容器部署重启实际承载 Gateway 的进程或容器。随后运行 openclaw plugins list 检查安装可见性，运行 openclaw plugins inspect sheen-pansync --runtime --json 确认 runtime toolNames 包含 pan_sync_upload、pan_sync_list、pan_sync_download，并在新会话中通过 /tools 验证更新前已经明确授权的 Tool 实际可用。不要新增权限，也不要把自动化检查冒充真实阿里云盘验收。最后报告旧版本、新版本、采用的更新路径、验证结果和仍需人工处理的事项。
```

## 卸载插件

### 手动卸载

先预览删除范围，再执行卸载：

```powershell
openclaw plugins uninstall sheen-pansync --dry-run
openclaw plugins uninstall sheen-pansync
openclaw gateway restart --safe
openclaw plugins list
```

非托管或容器部署应改为重启实际承载 Gateway 的进程或容器。随后新建会话并通过 `/tools` 确认三个 PanSync Tool 已不再可用。卸载命令会按 OpenClaw 的预览结果处理插件注册和安装文件；默认不要再手动删除凭据、配置、源码目录、工作区文件、防火墙规则或网盘内容。若还要彻底清理残留数据，应另行定位并展示每个精确目标，确认它属于 Sheen PanSync 且得到用户明确批准后再处理。

### 可复制提示词：自动卸载与保留数据

```text
请帮我安全卸载 Sheen PanSync。先检查插件安装来源、Gateway 承载方式、是否有本轮启动且 PID 已准确跟踪的临时配置进程，并说明 OpenClaw 卸载会删除什么、会保留什么。不要删除 Token 或凭据存储、插件配置、源码仓库、工作区文件、防火墙/安全组/NAT 规则或任何网盘内容，也不要改动其他插件和 Tool 策略。

先执行 openclaw plugins uninstall sheen-pansync --dry-run，把预览结果和风险告诉我；确认没有超出插件范围后执行 openclaw plugins uninstall sheen-pansync。只终止本轮由你亲自启动且持续跟踪了准确 PID 的临时配置进程，归属不确定的进程保持不动。然后让在线 Gateway 加载变更：OpenClaw 托管安装执行 openclaw gateway restart --safe；非托管或容器部署重启实际承载 Gateway 的进程或容器。使用 openclaw plugins list 检查插件已移除，并在新会话中通过 /tools 确认 pan_sync_upload、pan_sync_list、pan_sync_download 已不可用。

最后报告卸载结果以及明确保留的配置、凭据和用户数据。除非我另外明确要求彻底清理，并逐项确认你展示的精确目标，否则不要执行任何额外删除。
```

## 手动配置

1. 在 OpenClaw 主机上启动十分钟临时配置服务：

   ```powershell
   openclaw pan-sync configure
   ```

2. 阅读命令的**实际输出**。它会显示所选端口、一个 `Local URL`，以及一个或多个 `Remote URL`；没有非回环 IPv4 网卡时会明确提示未检测到远程地址。命令没有 `--remote-host` 参数，本机与远程 IPv4 访问默认同时启用。
3. 按浏览器位置选择地址：

   - 浏览器和 OpenClaw 在同一台主机：使用 `Local URL`。
   - 浏览器在同一局域网：使用能从浏览器到达的 `Remote URL`。
   - OpenClaw 在云主机或 NAT 后：如果 CLI 只显示私网地址，用主机的**实际公网 IP**只替换 URL 的主机部分，端口与 `#` 后的 fragment 必须原样保留。不要把 `0.0.0.0` 当作浏览器地址。

4. 远程访问需要临时允许命令实际选择的 TCP 端口。检查主机防火墙，以及云环境中的安全组和 NAT/端口映射。只新增本轮所需、来源清楚且能够回滚的规则；不要关闭整套防火墙，也不要改动已有无关规则。配置服务拒绝转发请求头，因此不要把反向代理当作已支持的访问方式。
5. 在十分钟内打开完整临时 URL。这个 URL 包含一次性 fragment：只交给当前操作者，不要放进截图、工单、长期文档或日志。页面使用临时 HTTP，安全边界是短时窗口、一次性 URL、配置 API 授权和端口及时回收；请只在可信网络路径上使用。
6. 在页面中打开 OpenList 授权入口，完成阿里云盘授权并取得 Token。回到配置页，**只在网页中**粘贴 OpenList 显示的 `refresh_token`，核对刷新 API 后保存。自定义刷新 API 会收到该 Token，只能填写你信任的服务。详细信任与恢复说明见 [OpenList 授权与 Token 恢复指南](docs/guides/aliyun-token.md)。
7. 初始配置页显示 `READY`，只表示临时页面已成功读取配置；成功保存并验证候选凭据后，页面显示 `SAVED_AND_VERIFIED`。持久凭据的 `ready` 状态只在已认证的 Sheen PanSync 只读 Control UI 状态标签页确认，不要把这三个状态混为一谈。不要把 Token 复制到聊天，也不要尝试通过普通 OpenClaw 插件配置写入它；该字段会被拒绝。插件不提供二维码登录。再运行 `openclaw plugins inspect sheen-pansync --runtime --json` 检查三个 runtime `toolNames`，并在新会话中通过 `/tools` 验证本轮明确授权的 Tool 实际可用。
8. 配置成功后服务会短暂显示结果再关闭；十分钟到期也会关闭。如果命令仍残留，只终止你为本轮命令启动并准确记录了 PID 的配置进程，预先存在或归属不确定的进程保持不动。确认本轮端口不再监听，再只删除本轮新增的主机防火墙、云安全组和端口映射规则。

![OpenClaw 调用 Pan Sync List 并显示三个 Tool 已安装、资源盘可达](docs/images/readme/01-plugin-ready.png)

截图展示的是新会话中的资源盘根目录探测与 Tool 可达性，不显示临时配置页状态或 Control UI 中的持久凭据状态。

## 插件用法

下面的文本都可以直接交给 OpenClaw。若 Tool 未获当前 Agent 的有效权限，先按常见问题中的方法修复权限，不要反复调用。

### 上传文件

上传工作区中已有文件：

```text
把 reports/weekly.md 上传到阿里云盘。
```

要求 OpenClaw 先创建再上传：

```text
在当前工作区生成 summary.txt，写入本周工作摘要；确认文件已保存后，把它上传到阿里云盘。
```

OpenClaw 应先确认本地文件存在，再调用 `pan_sync_upload`。未指定远端目录时上传到 `/openClawShare`；远端同名文件不会被覆盖，目标始终是资源盘。

![上传到阿里云盘资源盘](docs/images/readme/02-upload-resource-drive.png)

### 列出或搜索网盘文件

列出资源盘根目录：

```text
列出阿里云盘资源盘根目录里的文件。
```

按名称搜索整个资源盘：

```text
在阿里云盘里搜索 summary.txt。
```

也可以在请求中给出网盘目录来缩小范围。OpenClaw 应调用 `pan_sync_list`；结果还有下一页时，只使用 Tool 返回的 cursor 继续。

如果同名结果不止一个，应先消除歧义：

```text
在网盘中搜索 report.pdf；如果有多个结果，列出各自的名称、类型、大小和网盘路径让我选择，不要自行下载。
```

![列出或搜索资源盘文件](docs/images/readme/03-search-resource-drive.png)

### 下载并读取

已有精确路径时：

```text
下载 /openClawShare/summary.txt 到当前工作区并读取内容。
```

只有文件名时：

```text
先在网盘中搜索 summary.txt；只有一个匹配项时下载到工作区并总结，有多个时先让我选择。
```

OpenClaw 应先用 `pan_sync_list` 确认目标，再用 `pan_sync_download` 下载一个普通文件，最后通过常规工作区文件工具读取返回的相对 `localPath`。下载默认落到工作区根目录；本地同名文件会保留，新文件自动使用 `name (1).ext`、`name (2).ext` 等名称。文件夹不会被递归下载。

![下载后由 OpenClaw 读取工作区副本](docs/images/readme/04-download-and-read.png)

“同步网盘”没有说明方向，OpenClaw 必须先问是“上传到网盘”还是“从网盘下载”，不能先调用 Tool。请直接使用下面的澄清请求：

```text
同步网盘；如果方向不明确，先问我是要上传到网盘还是从网盘下载，不要先执行任何文件操作。
```

### 大文件确认

文件大于 `100 * 1024 * 1024` 字节时，第一次下载只返回 `DOWNLOAD_CONFIRMATION_REQUIRED`，不会创建本地文件。OpenClaw 应显示这一个文件的安全名称和大小并请求确认：

```text
这个文件超过 100 MiB。请告诉我文件名和大小，并等我明确确认后再下载；不要把这次确认用于其他文件。
```

只有用户对当前文件明确同意后，这次确认才授权**紧接着的一次** `pan_sync_download` 重试：必须使用与触发确认时完全相同的 `fileId`/`remotePath`，并设置 `confirmedLargeDownload: true`。该确认绝不能用于另一个文件或另一次调用；如果这次紧接的重试再次要求确认，立即停止并报告，不能循环重试。

## 常见问题与解决方法

### 远端主机本地能访问，外部浏览器打不开

先确认 `openclaw pan-sync configure` 仍在运行且十分钟未到，再检查浏览器到主机实际端口的网络路径。常见阻塞点是 Windows Firewall、`firewalld`、`ufw`、云安全组或 NAT/端口映射。只临时放行 CLI 实际选择的 TCP 端口；若云平台无法由当前操作者安全修改，记录所需协议、端口、来源范围和删除步骤，交给有权限的人处理。不要记录真实 IP、动态端口或完整配置 URL。

### CLI 只显示私网 Remote URL，但云服务器有公网 IP

插件不会调用第三方服务查询公网 IP。确认云主机的真实公网映射后，只替换 CLI 输出 URL 的主机部分，完整保留端口、路径和 fragment。若还存在 NAT，确保同一端口的映射和云安全组规则都生效。配置完成后撤销且只撤销本轮新增的规则。

### 端口占用、十分钟过期或配置进程残留

每次命令会选择一个浏览器安全的可用端口，请始终使用本次输出，不要沿用旧端口。页面过期或一次性 URL 泄漏时，只终止启动时已记录准确 PID 的本轮配置进程，再启动新命令；旧 URL 不再使用。若进程 PID 未跟踪或归属不确定，应保留它并报告，不能猜测终止。保存完成或到期后检查本轮监听已关闭。

### 临时配置页为什么是 HTTP？一次性 URL 泄漏怎么办？

当前功能不负责 HTTPS 证书或反向代理。它依靠十分钟窗口、一次性 fragment、授权请求和及时关闭来缩短暴露时间，因此应使用可信路径并把临时 URL 当作短期敏感信息。URL 一旦误发、截图或进入日志，只关闭启动时已记录准确 PID 的本轮配置进程，清理本轮临时网络规则，再启动新的一轮；归属不确定的进程保持不动，不要继续使用泄漏的 URL。

### OpenList 页面打不开、Token 被拒绝或状态不是 ready

检查配置页中的 OpenList 授权入口和刷新 API 是否是你信任的完整地址。`unconfigured` 或 Tool 返回 `CREDENTIALS_REQUIRED` 时重新配置；`reauth_required` 表示需要在 OpenList 重新授权并取得新 Token；`degraded` 或 `rate_limited` 时等待页面显示的冷却期，不要循环重试。只在配置网页中提交 Token。进一步排查见 [OpenList 授权与 Token 恢复指南](docs/guides/aliyun-token.md)。

### 插件已安装，但当前会话看不到 Tool

安装可见性、runtime 注册和当前 Agent 的有效 Tool 策略是三道独立门禁。`openclaw plugins list` 只确认插件已安装并可见，可能显示 `loaded`，不能证明三个 Tool 已注册。运行下面的命令，并确认 runtime `toolNames` 包含三个 Tool：

```powershell
openclaw plugins inspect sheen-pansync --runtime --json
```

随后检查真正生效的全局或 Agent 级策略。先确认用户明确请求或授权了上传、列出/搜索、下载中的哪些能力，只把对应 Tool 合并到适用的 `allow` 或 `alsoAllow`；不要默认授予全部三个 Tool。若某个所需 Tool 被显式 `deny` 阻止，先报告该精确 deny、所在策略层及影响，取得用户确认后才能移除那一个精确条目。保留其他 deny、无关条目和策略层，绝不能用固定数组整体覆盖已有策略。

本轮确实修改策略后，必须让在线 Gateway 加载变更。OpenClaw 托管安装执行：

```powershell
openclaw gateway restart --safe
```

非托管或容器部署则重启实际承载 Gateway 的进程或容器。runtime inspect 不能替代这一步。然后新建 OpenClaw 会话，先通过 `/tools` 确认本轮明确授权的 Tool 实际可用，再验证相应能力。旧会话不能证明新策略已经生效。若问题仍在，核对 OpenClaw 版本是否满足要求，以及修改的是不是当前 Agent 实际使用的策略层级。

### 没有资源盘，或者资源盘 ID 缺失

插件必须从账号摘要得到非空的 `resource_drive_id`。缺失时返回 `RESOURCE_DRIVE_UNAVAILABLE`，不会改用 `default_drive_id` 或 `backup_drive_id`，也不会向备份盘读写。请先确认账号确实具有可用资源盘。

### 下载没有可写工作区、发生同名冲突，或目标是文件夹

没有当前可写工作区时可以列出和搜索，但下载会返回安全错误；为会话提供工作区后重试。已存在的本地同名文件不会被覆盖，插件会自动改名。当前一次只下载一个普通文件，不支持递归下载文件夹。

### 大文件确认后又要求确认

超过 100 MiB 的明确批准只授权紧接着的一次 `pan_sync_download` 重试；它必须沿用触发确认时完全相同的 `fileId`/`remotePath`，并带上 `confirmedLargeDownload: true`。不能把批准用于另一个文件或之后的调用；若这一次紧接的重试仍返回 `DOWNLOAD_CONFIRMATION_REQUIRED`，停止并报告，不要再次请求确认或循环重试。

### 可复制提示词：Token 应急重新配置

```text
请帮我重新配置 Sheen PanSync 的 Token。不要默认重装插件，也不要要求我把 refresh_token 发到对话中。

先用 openclaw plugins list 检查插件安装可见性，再用 openclaw plugins inspect sheen-pansync --runtime --json 检查 runtime toolNames，并在新会话中通过 /tools 检查本轮明确授权的 Tool 实际权限；同时检查当前稳定状态码。在后台启动新的 openclaw pan-sync configure，准确记录并持续跟踪你启动的配置进程 PID，读取实际 Local URL、Remote URL 和端口；根据当前主机的防火墙、云安全组、NAT/端口映射和公网 IP 情况，只添加本轮需要且可回滚的临时访问规则。把十分钟临时配置 URL 发给我，让我只在网页中填写新 Token。

等我确认保存后，区分检查配置页状态：初始读取成功为 READY，成功保存并验证为 SAVED_AND_VERIFIED；再只在已认证的 Sheen PanSync 只读 Control UI 状态标签页验证持久凭据状态为 ready，并执行一次不泄露账号、Token、网盘 ID 或完整配置 URL 的安全检查。随后只终止你在本轮启动并持续跟踪了准确 PID 的配置进程；预先存在、PID 未跟踪或归属不确定的进程一律保留。只清理由本轮新增的主机防火墙、云安全组或端口映射规则。若仍失败，请报告稳定错误码、确认过的原因和下一步，不要索取 Token 或原始敏感日志。
```

## 开发与发布校验

在仓库根目录运行完整门禁；它会执行类型检查、单元测试、集成测试、构建与 npm tarball 内容检查：

```powershell
npm ci
npm run verify
```

发布前还应检查实际打包并安装后的运行时，而不是只从源码目录加载：

```powershell
$panSyncVerificationRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("pan-sync-release-" + [Guid]::NewGuid().ToString("N"))
$panSyncStateDir = Join-Path $panSyncVerificationRoot "openclaw-state"
$previousPanSyncStateDir = $env:OPENCLAW_STATE_DIR
$previousPanSyncConfigPath = $env:OPENCLAW_CONFIG_PATH
New-Item -ItemType Directory -Path $panSyncStateDir | Out-Null
try {
  $env:OPENCLAW_STATE_DIR = $panSyncStateDir
  Remove-Item Env:OPENCLAW_CONFIG_PATH -ErrorAction SilentlyContinue
  $panSyncTarball = (npm pack --json | ConvertFrom-Json)[0].filename
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($panSyncTarball)) {
    throw "npm pack did not return a tarball filename"
  }
  openclaw plugins install "npm-pack:./$panSyncTarball" --force
  openclaw plugins inspect sheen-pansync --runtime --json
} finally {
  if ($null -eq $previousPanSyncStateDir) { Remove-Item Env:OPENCLAW_STATE_DIR -ErrorAction SilentlyContinue } else { $env:OPENCLAW_STATE_DIR = $previousPanSyncStateDir }
  if ($null -eq $previousPanSyncConfigPath) { Remove-Item Env:OPENCLAW_CONFIG_PATH -ErrorAction SilentlyContinue } else { $env:OPENCLAW_CONFIG_PATH = $previousPanSyncConfigPath }
  $resolvedVerificationRoot = [System.IO.Path]::GetFullPath($panSyncVerificationRoot)
  $resolvedTempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
  if (-not $resolvedVerificationRoot.StartsWith($resolvedTempRoot, [StringComparison]::OrdinalIgnoreCase) -or -not (Split-Path $resolvedVerificationRoot -Leaf).StartsWith("pan-sync-release-")) {
    throw "refusing unexpected verification-state cleanup"
  }
  Remove-Item -LiteralPath $resolvedVerificationRoot -Recurse -Force
}
```

这段校验只使用任务专属的临时 `OPENCLAW_STATE_DIR`，并在受校验的临时路径内清理；不会安装到或删除当前使用中的 OpenClaw 状态。

自动化通过不等于真实环境验收。发布前仍需在实际远程环境中验证浏览器可达、配置页成功保存后显示 `SAVED_AND_VERIFIED`、已认证的 Sheen PanSync 只读 Control UI 状态标签页显示持久凭据状态 `ready`、真实资源盘上传/列出/搜索/下载、配置端口关闭，以及本轮临时防火墙/安全组/NAT 规则已清理。验收记录不得包含 Token、完整一次性配置 URL、真实 IP、动态端口、账号标识、网盘 ID 或原始敏感日志。

## 许可证

本项目使用 [MIT License](LICENSE)。

---

## English

[中文](#中文) | [English](#english)

Sheen PanSync lets OpenClaw safely upload, find, and download cloud-drive files. Aliyun Drive is currently the only supported provider.

## What the plugin does

The plugin registers three tools:

- `pan_sync_upload`: uploads an existing file from the current OpenClaw workspace to Aliyun Drive.
- `pan_sync_list`: lists a cloud-drive directory or searches for files by name.
- `pan_sync_download`: downloads one regular file into the current workspace so OpenClaw can read, summarize, or process it with its normal file capabilities.

Uploads go to `/openClawShare` by default. Listing and search start at the resource-drive root `/`, and downloads go to the current workspace root. The plugin does not recursively download directories or place cloud-file contents directly in Tool results. For Aliyun Drive, uploads, downloads, and listings operate only on the **resource drive**.

OpenList is used only for Aliyun Drive authorization and Token refresh; file content is transferred directly between the plugin and Aliyun Drive. A Token can only be submitted through the ten-minute temporary configuration page and is then stored in the encrypted credential store. Normal plugin configuration rejects `refresh_token`. The plugin does not provide QR-code login or login polling.

Requirements: Node.js `22.22.3` or later and OpenClaw `2026.7.1-2` or a compatible later release. Downloads also require a writable workspace in the current OpenClaw session.

## Let OpenClaw install it for you

If OpenClaw can operate the deployment host, copy the complete prompt below to it. You still need to enter the Token in your browser and approve actions that require cloud-platform permissions.

### Copyable prompt: first installation, configuration, and verification

```text
Install and configure openclaw-plugin-sheen-pansync for me. First identify the operating system, shell, OpenClaw version, plugin state, workspace, and effective Tool policy. Preserve all unrelated configuration and user changes.

Prefer npm installation and enable the plugin. First determine which of upload, list/search, and download I explicitly requested or authorized, and merge only the corresponding Tools into the effective global or Agent-level policy. Preserve every other policy entry and layer. If an explicit deny blocks a required Tool, report the exact conflict and impact, and remove only that exact deny after I approve it. Never silently allow all three Tools or replace an entire allow, alsoAllow, or deny list. If this run installs or enables the plugin or changes Tool policy, make the live Gateway load the change: run openclaw gateway restart --safe for an OpenClaw-managed Gateway, or restart the actual Gateway process or container for an unmanaged/container deployment. Use openclaw plugins list only to check installation visibility, then use openclaw plugins inspect sheen-pansync --runtime --json and confirm runtime toolNames contains pan_sync_upload, pan_sync_list, and pan_sync_download. Runtime inspection alone does not prove the live Gateway loaded the change.

Start openclaw pan-sync configure in the background. Record and continuously track the exact PID you started, and read the actual Local URL, Remote URL, and port printed by the command. Determine whether I will connect from the same host, a LAN, or the public internet. Check port conflicts, the host firewall, cloud security groups, NAT/port forwarding, and the public IP. Automatically change only settings you can verify and roll back. If I must operate the cloud platform, give exact steps and wait. If a cloud host prints only a private Remote URL, replace only its host with the actual public IP while preserving the port and fragment.

Send me the usable ten-minute configuration URL. Do not ask me to send refresh_token in chat; remind me to paste the Token only into the configuration page. READY means only that the temporary page loaded its configuration. A successfully saved and verified candidate credential must show SAVED_AND_VERIFIED. Then check the persistent credential state is ready only in the authenticated read-only Sheen PanSync Control UI status tab, inspect runtime toolNames again, and use /tools in a new session to verify that the Tools explicitly authorized for this run are actually available.

Finally, terminate only the temporary configuration process whose exact PID you started and continuously tracked during this run. Preserve every pre-existing process and every process with an untracked or uncertain owner. Remove only host-firewall, cloud-security-group, or port-forwarding rules created during this run; never remove pre-existing or uncertain rules. Report automated verification separately from acceptance that still requires a real Aliyun Drive account.
```

## Manual installation

Confirm the Node.js and OpenClaw versions on the OpenClaw host first. Run the following PowerShell commands in the user environment where the plugin should be installed.

### Install from npm

```powershell
openclaw plugins install npm:openclaw-plugin-sheen-pansync
openclaw plugins enable sheen-pansync
openclaw gateway restart --safe
openclaw plugins list
openclaw plugins inspect sheen-pansync --runtime --json
```

`openclaw gateway restart --safe` applies to an OpenClaw-managed Gateway. For an unmanaged or container deployment, restart the actual process or container that runs the Gateway. `plugins list` only proves the plugin is installed and visible; even a `loaded` label does not prove runtime Tool registration. The runtime `toolNames` must contain `pan_sync_upload`, `pan_sync_list`, and `pan_sync_download`. Finally, create a new OpenClaw session and run `/tools` to confirm the Tools you explicitly authorized are available under the effective policy.

### Clone, build, and install from source

```powershell
git clone https://github.com/EdouardRichard/openclaw-plugin-sheen-pansync.git
Set-Location openclaw-plugin-sheen-pansync
npm ci
npm run build
openclaw plugins install .
openclaw plugins enable sheen-pansync
openclaw gateway restart --safe
```

For an unmanaged or container deployment, restart the actual Gateway process or container instead. Then check installation visibility with `openclaw plugins list`, runtime `toolNames` with `openclaw plugins inspect sheen-pansync --runtime --json`, and actual availability with `/tools` in a new session. Runtime inspection and source tests do not replace the live-Gateway and new-session checks.

## Update the plugin

### Manual update

Preview the tracked update before applying it:

```powershell
openclaw plugins update sheen-pansync --dry-run
openclaw plugins update sheen-pansync
openclaw gateway restart --safe
openclaw plugins list
openclaw plugins inspect sheen-pansync --runtime --json
```

For an unmanaged or container deployment, restart the actual Gateway process or container. Then create a new session and use `/tools` to confirm the previously authorized Tools remain available. Updating does not require entering the Token again and must not reset credentials, plugin configuration, Tool policies, or unrelated user changes.

If `plugins update` reports that the installation source is not tracked, update through the original source. For npm, run `openclaw plugins install npm:openclaw-plugin-sheen-pansync --force`. For a source installation, first ensure local changes are accounted for, then fetch the intended version, run `npm ci` and `npm run build`, and finish with `openclaw plugins install . --force`. Never delete configuration or credential directories as an update shortcut.

### Copyable prompt: update and verify

```text
Safely update Sheen PanSync for me. First inspect the operating system, OpenClaw version, current plugin version, installation source, Gateway deployment, effective Tool policy, and workspace state. Preserve all credentials, plugin configuration, Tool policies, local source changes, and unrelated user files. Do not ask me for refresh_token.

Run openclaw plugins update sheen-pansync --dry-run first and explain the expected changes, then run openclaw plugins update sheen-pansync. If update does not track this source, use the original installation source: use the supported forced npm reinstall path for npm, or check for uncommitted source changes before pulling, installing dependencies, building, and force-installing a source checkout. Never overwrite or discard local changes. Report real version, network, permission, or installation-policy errors instead of deleting configuration or credentials to bypass them.

After updating, make the live Gateway load the change: run openclaw gateway restart --safe for an OpenClaw-managed Gateway, or restart the actual Gateway process or container otherwise. Run openclaw plugins list for installation visibility, run openclaw plugins inspect sheen-pansync --runtime --json and confirm runtime toolNames contains pan_sync_upload, pan_sync_list, and pan_sync_download, then use /tools in a new session to verify the previously authorized Tools. Do not grant new permissions or present automated checks as real Aliyun Drive acceptance. Report the old version, new version, update path, verification results, and any remaining manual action.
```

## Uninstall the plugin

### Manual uninstall

Preview the removal scope first:

```powershell
openclaw plugins uninstall sheen-pansync --dry-run
openclaw plugins uninstall sheen-pansync
openclaw gateway restart --safe
openclaw plugins list
```

For an unmanaged or container deployment, restart the actual Gateway process or container. Create a new session and use `/tools` to confirm all three PanSync Tools are gone. The uninstall command handles plugin registration and installed files according to its preview. Do not additionally delete credentials, configuration, source directories, workspace files, firewall rules, or cloud-drive content by default. A full data cleanup must be a separate, explicit request: locate and show every exact target, prove it belongs to Sheen PanSync, and obtain user approval before deleting it.

### Copyable prompt: uninstall while retaining data

```text
Safely uninstall Sheen PanSync for me. First inspect its installation source, Gateway deployment, and any temporary configuration process started during this run whose exact PID is continuously tracked. Explain what OpenClaw will remove and retain. Do not delete Token or credential storage, plugin configuration, source repositories, workspace files, firewall/security-group/NAT rules, cloud-drive content, other plugins, or unrelated Tool policies.

Run openclaw plugins uninstall sheen-pansync --dry-run first and show me the scope and risks. If it stays within the plugin scope, run openclaw plugins uninstall sheen-pansync. Terminate only a temporary configuration process whose exact PID you personally started and continuously tracked during this run; preserve uncertain processes. Make the live Gateway load the change by running openclaw gateway restart --safe for an OpenClaw-managed Gateway or restarting the actual Gateway process or container otherwise. Use openclaw plugins list to confirm removal and /tools in a new session to confirm pan_sync_upload, pan_sync_list, and pan_sync_download are unavailable.

Finally report the uninstall result and the configuration, credentials, and user data that were retained. Perform no additional deletion unless I separately request a full cleanup and approve every exact target you show me.
```

## Manual configuration

1. Start the ten-minute temporary configuration service on the OpenClaw host:

   ```powershell
   openclaw pan-sync configure
   ```

2. Read the command's **actual output**. It prints the selected port, one `Local URL`, and one or more `Remote URL` values. If no non-loopback IPv4 interface is available, it says that no remote address was detected. There is no `--remote-host` option; local and remote IPv4 access are enabled together by default.
3. Choose the address based on the browser location:

   - Same host as OpenClaw: use the `Local URL`.
   - Same LAN: use a `Remote URL` reachable from the browser.
   - Cloud host or NAT: if the CLI prints only a private address, replace only the URL host with the host's **actual public IP**. Preserve the port and everything after `#`. Do not use `0.0.0.0` as a browser address.

4. Remote access requires temporarily allowing the TCP port actually selected by the command. Check the host firewall, cloud security group, and NAT/port forwarding. Add only rules needed for this run whose origin and rollback are clear. Do not disable the whole firewall or change unrelated rules. The configuration service rejects forwarded-request headers, so reverse proxying is not a supported access method.
5. Open the complete temporary URL within ten minutes. It contains a one-time fragment. Give it only to the current operator; do not put it in screenshots, tickets, long-lived documents, or logs. The page uses temporary HTTP. Its protection boundary is the short window, one-time URL, authorized configuration API, and prompt port cleanup, so use a trusted network path.
6. Open the OpenList authorization entry on the page, authorize Aliyun Drive, and obtain the Token. Return to the configuration page and paste the OpenList `refresh_token` **only into the web page**. Check the refresh API before saving. A custom refresh API receives the Token, so use only a service you trust. See [OpenList authorization and Token recovery](docs/guides/aliyun-token.md) for trust and recovery details.
7. `READY` only means the temporary page loaded its configuration. After a candidate credential is saved and verified, the page shows `SAVED_AND_VERIFIED`. Confirm the persistent credential state is `ready` only in the authenticated read-only Sheen PanSync Control UI status tab. Do not confuse these three states. Never paste the Token into chat or normal OpenClaw plugin configuration; that field is rejected. The plugin does not provide QR-code login. Inspect the three runtime `toolNames`, then use `/tools` in a new session to verify the Tools explicitly authorized for this run.
8. After successful configuration, the service briefly displays the result and closes; it also closes when ten minutes expire. If a process remains, terminate only the configuration PID you started and accurately recorded for this run. Leave pre-existing or uncertain processes alone. Confirm the selected port is no longer listening, then remove only firewall, security-group, and port-forwarding rules created for this run.

![OpenClaw invokes Pan Sync List and shows that the three Tools are installed and the resource drive is reachable](docs/images/readme/01-plugin-ready.png)

The screenshot shows resource-drive root probing and Tool availability in a new session. It does not show temporary configuration-page state or persistent credential state in the Control UI.

## Using the plugin

The following prompts can be sent directly to OpenClaw. If the current Agent lacks effective Tool permission, fix the policy as described in Troubleshooting instead of repeatedly calling the Tool.

### Upload a file

Upload an existing workspace file:

```text
Upload reports/weekly.md to Aliyun Drive.
```

Create a file first and then upload it:

```text
Create summary.txt in the current workspace with this week's summary. After confirming the file was saved, upload it to Aliyun Drive.
```

OpenClaw should confirm the local file exists before calling `pan_sync_upload`. If no remote directory is specified, the upload goes to `/openClawShare`. Existing remote files are not overwritten, and the destination is always the resource drive.

![Upload to the Aliyun Drive resource drive](docs/images/readme/02-upload-resource-drive.png)

### List or search cloud-drive files

```text
List the files in the root of my Aliyun Drive resource drive.
```

```text
Search my entire Aliyun Drive resource drive for summary.txt.
```

A cloud-drive directory can be supplied to narrow the scope. OpenClaw should call `pan_sync_list`; when another page exists, it must continue only with the cursor returned by the Tool.

Resolve duplicate names before downloading:

```text
Search the cloud drive for report.pdf. If there are multiple matches, show their name, type, size, and cloud-drive path so I can choose. Do not download anything yet.
```

![List or search resource-drive files](docs/images/readme/03-search-resource-drive.png)

### Download and read

With an exact path:

```text
Download /openClawShare/summary.txt into the current workspace and read it.
```

With only a filename:

```text
Search the cloud drive for summary.txt first. Download it into the workspace and summarize it only if there is one match; ask me to choose if there are multiple matches.
```

OpenClaw should use `pan_sync_list` to identify the target, `pan_sync_download` to download one regular file, and normal workspace file tools to read the returned relative `localPath`. Downloads go to the workspace root by default. Existing local files are preserved, and the new file is renamed to `name (1).ext`, `name (2).ext`, and so on. Directories are not downloaded recursively.

![Read the workspace copy after download](docs/images/readme/04-download-and-read.png)

“Sync the cloud drive” does not state a direction. OpenClaw must ask whether to upload or download before calling a Tool:

```text
Sync the cloud drive. If the direction is unclear, ask whether I want to upload to the drive or download from it before performing any file operation.
```

### Large-file confirmation

When a file is larger than `100 * 1024 * 1024` bytes, the first download returns `DOWNLOAD_CONFIRMATION_REQUIRED` without creating a local file. OpenClaw should show the safe filename and size and request confirmation:

```text
This file is larger than 100 MiB. Tell me its filename and size, and wait for my explicit approval before downloading it. Do not reuse this approval for another file.
```

Approval for the current file authorizes only the **immediately following** `pan_sync_download` retry with the exact same `fileId`/`remotePath` and `confirmedLargeDownload: true`. It cannot authorize another file or later call. If that immediate retry requests confirmation again, stop and report the issue instead of looping.

## Troubleshooting

### The remote host can access the page locally, but an external browser cannot

Confirm `openclaw pan-sync configure` is still running and has not reached the ten-minute limit, then inspect the path from the browser to the actual port. Typical blockers are Windows Firewall, `firewalld`, `ufw`, a cloud security group, or NAT/port forwarding. Temporarily allow only the TCP port selected by the CLI. If the current operator cannot safely change the cloud platform, record the protocol, port, source range, and removal steps for an authorized operator. Do not record real IP addresses, dynamic ports, or the full configuration URL.

### The CLI prints a private Remote URL, but the server has a public IP

The plugin does not call third-party services to discover a public IP. Confirm the actual public mapping, then replace only the host in the CLI URL and preserve its port, path, and fragment. If NAT is also present, ensure the same port mapping and security-group rule are active. Remove only rules created for this run when configuration is complete.

### Port conflict, ten-minute expiry, or a leftover configuration process

Each command selects an available browser-safe port. Always use the current output. If the page expires or its URL leaks, terminate only the current configuration process whose exact PID was recorded at startup, then run a new command. Preserve processes with an untracked or uncertain owner. Confirm the listener closes after saving or expiry.

### Why HTTP, and what if the one-time URL leaks?

This feature does not manage HTTPS certificates or a reverse proxy. It limits exposure with a ten-minute window, one-time fragment, authorized requests, and prompt shutdown. Use a trusted path and treat the URL as short-lived sensitive information. If it appears in a message, screenshot, or log, stop only the current process whose PID was accurately tracked, remove only temporary network rules from this run, and start a new configuration. Do not keep using the leaked URL.

### OpenList does not open, the Token is rejected, or state is not ready

Check that the OpenList authorization entry and refresh API shown on the configuration page are complete addresses you trust. Reconfigure for `unconfigured` or `CREDENTIALS_REQUIRED`. `reauth_required` means OpenList authorization and a new Token are required. For `degraded` or `rate_limited`, wait for the displayed cooldown instead of retrying in a loop. Submit the Token only through the configuration page. See [OpenList authorization and Token recovery](docs/guides/aliyun-token.md).

### The plugin is installed, but the current session cannot see its Tools

Installation visibility, runtime registration, and the effective Agent Tool policy are separate gates. Run:

```powershell
openclaw plugins inspect sheen-pansync --runtime --json
```

Confirm `toolNames` contains all three Tools. Then inspect the effective global or Agent policy. Add only Tools explicitly requested or authorized to the applicable `allow` or `alsoAllow`. If an explicit `deny` blocks one, report the exact entry, policy layer, and impact before removing only that entry with user approval. Preserve all other entries and layers.

After a policy change, run `openclaw gateway restart --safe` for a managed Gateway or restart the actual unmanaged/container Gateway. Then use `/tools` in a new session. An old session does not prove a new policy is active. If the problem remains, verify the OpenClaw version and the policy layer actually used by the current Agent.

### The account has no resource drive or its ID is missing

The plugin requires a non-empty `resource_drive_id` from the account summary. It returns `RESOURCE_DRIVE_UNAVAILABLE` when missing and never falls back to `default_drive_id` or `backup_drive_id`. Confirm that the account has an available resource drive.

### No writable workspace, a local name conflict, or the target is a directory

Listing and search still work without a writable workspace, but download returns a safe error. Provide a workspace and retry. Existing local files are never overwritten; the plugin chooses a new name. It downloads one regular file at a time and does not recursively download directories.

### A large file asks for confirmation again

Approval over 100 MiB authorizes only the immediately following retry with the same `fileId`/`remotePath` and `confirmedLargeDownload: true`. If that retry still returns `DOWNLOAD_CONFIRMATION_REQUIRED`, stop and report it. Do not ask again or loop.

### Copyable prompt: emergency Token reconfiguration

```text
Reconfigure the Sheen PanSync Token for me. Do not reinstall the plugin by default, and do not ask me to send refresh_token in chat.

Use openclaw plugins list to check installation visibility, openclaw plugins inspect sheen-pansync --runtime --json to inspect runtime toolNames, and /tools in a new session to check the Tools explicitly authorized for this run. Also inspect the current stable status code. Start a new openclaw pan-sync configure process in the background, record and continuously track its exact PID, and read its actual Local URL, Remote URL, and port. Based on the host firewall, cloud security group, NAT/port forwarding, and public IP, add only temporary access rules needed for this run that can be rolled back. Send me the ten-minute URL and have me enter the new Token only on the web page.

After I confirm saving, distinguish the states: READY means the temporary page loaded, SAVED_AND_VERIFIED means the candidate credential was saved and verified, and persistent ready must be checked only in the authenticated read-only Sheen PanSync Control UI status tab. Perform one safe check that does not expose account data, Token, cloud-drive IDs, or the full configuration URL. Terminate only the configuration process whose exact PID you started and continuously tracked during this run; preserve every pre-existing, untracked, or uncertain process. Remove only firewall, security-group, or port-forwarding rules created during this run. If it still fails, report the stable error code, confirmed cause, and next step without requesting the Token or raw sensitive logs.
```

## Development and release verification

Run the full gate from the repository root. It performs type checking, unit tests, integration tests, a build, and npm tarball-content checks:

```powershell
npm ci
npm run verify
```

Before release, also inspect the runtime installed from the actual package instead of loading only from the source directory:

```powershell
$panSyncVerificationRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("pan-sync-release-" + [Guid]::NewGuid().ToString("N"))
$panSyncStateDir = Join-Path $panSyncVerificationRoot "openclaw-state"
$previousPanSyncStateDir = $env:OPENCLAW_STATE_DIR
$previousPanSyncConfigPath = $env:OPENCLAW_CONFIG_PATH
New-Item -ItemType Directory -Path $panSyncStateDir | Out-Null
try {
  $env:OPENCLAW_STATE_DIR = $panSyncStateDir
  Remove-Item Env:OPENCLAW_CONFIG_PATH -ErrorAction SilentlyContinue
  $panSyncTarball = (npm pack --json | ConvertFrom-Json)[0].filename
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($panSyncTarball)) {
    throw "npm pack did not return a tarball filename"
  }
  openclaw plugins install "npm-pack:./$panSyncTarball" --force
  openclaw plugins inspect sheen-pansync --runtime --json
} finally {
  if ($null -eq $previousPanSyncStateDir) { Remove-Item Env:OPENCLAW_STATE_DIR -ErrorAction SilentlyContinue } else { $env:OPENCLAW_STATE_DIR = $previousPanSyncStateDir }
  if ($null -eq $previousPanSyncConfigPath) { Remove-Item Env:OPENCLAW_CONFIG_PATH -ErrorAction SilentlyContinue } else { $env:OPENCLAW_CONFIG_PATH = $previousPanSyncConfigPath }
  $resolvedVerificationRoot = [System.IO.Path]::GetFullPath($panSyncVerificationRoot)
  $resolvedTempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
  if (-not $resolvedVerificationRoot.StartsWith($resolvedTempRoot, [StringComparison]::OrdinalIgnoreCase) -or -not (Split-Path $resolvedVerificationRoot -Leaf).StartsWith("pan-sync-release-")) {
    throw "refusing unexpected verification-state cleanup"
  }
  Remove-Item -LiteralPath $resolvedVerificationRoot -Recurse -Force
}
```

This check uses a task-specific temporary `OPENCLAW_STATE_DIR` and cleans only its validated temporary path. It does not install into or delete the active OpenClaw state.

Automated checks are not real-environment acceptance. Before release, verify external browser access, `SAVED_AND_VERIFIED` after saving, persistent `ready` in the authenticated read-only Control UI, real resource-drive upload/list/search/download, closure of the configuration port, and cleanup of temporary firewall/security-group/NAT rules. Acceptance evidence must not contain a Token, full one-time URL, real IP, dynamic port, account identifier, cloud-drive ID, or raw sensitive logs.

## License

This project is licensed under the [MIT License](LICENSE).
