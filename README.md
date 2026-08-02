# OpenClaw Pan Sync Helper

Pan Sync Helper lets OpenClaw upload workspace files to an Aliyun Drive resource drive, search or list that drive, and download one cloud file into the current workspace for normal OpenClaw file work. OpenList is used only to obtain and refresh authorization; file bytes move directly between the plugin and Aliyun Drive.

[中文](#中文快速上手) · [English](#english-quick-start)

## 中文快速上手

### 1. 插件价值与边界

Pan Sync Helper 为 OpenClaw 提供三个明确的阿里云盘操作：

- `pan_sync_upload`：把已存在的工作区文件上传到阿里云盘。
- `pan_sync_list`：列出目录或按名称搜索文件。
- `pan_sync_download`：把一个普通文件下载到当前工作区，再交给 OpenClaw 的常规文件工具读取、总结或处理。

所有文件操作**只访问资源盘**，不会回退到备份盘。默认上传目录是 `/openClawShare`；列出和搜索默认从资源盘根目录 `/` 开始；下载默认保存到当前 OpenClaw 工作区根目录。插件不会递归下载文件夹，也不会把网盘文件内容直接放进 Tool 返回值。

### 2. 环境要求

- Node.js `22.22.3` 或更高版本。
- OpenClaw `2026.7.1-2` 或兼容的更高版本。
- 一个可以在 OpenList 中获取阿里云盘 refresh token 的账号。
- OpenClaw 当前会话必须有可写工作区，才能使用下载功能。

### 3. 安装并启用

安装已发布的 npm 包：

```bash
openclaw plugins install openclaw-pan-sync-helper
```

从本地源码安装时，先构建再安装当前目录：

```bash
npm install
npm run build
openclaw plugins install .
```

检查插件是否已启用：

```bash
openclaw plugins list
```

列表中应显示 `Pan Sync Helper` 为 `enabled`，并提供三个 Tool。

### 4. 通过 OpenList 配置 refresh token

插件只接受手动粘贴的 `refresh_token`，不在插件内实现二维码登录或轮询。令牌获取保留在 OpenList 页面中完成。

1. 在运行 OpenClaw 的主机上执行：

   ```bash
   openclaw pan-sync configure
   ```

2. 打开命令输出的完整一次性回环地址。该地址最多有效十分钟；不要转发、分享或截图。
3. 在本地配置页中检查 OpenList 授权页地址。中国大陆默认值为 `https://api.oplist.org.cn`。
4. 在 OpenList 中完成阿里云盘授权并复制它显示的 refresh token。
5. 回到本地配置页，只粘贴 refresh token；检查完整的刷新 API 地址（默认 `https://api.oplist.org.cn/alicloud/renewapi`），然后保存。

自定义刷新 API 会接收到你粘贴的 refresh token，仅在你信任该服务时使用。插件不会替换主机、追加路径或静默切换备用服务。更完整的说明见 [OpenList 授权与令牌恢复指南](docs/guides/aliyun-token.md)。

### 5. 确认 `ready` 状态

保存成功后，本地配置页显示 `ready`，表示当前 Aliyun access token 可用于文件操作。普通状态和 Tool 结果不会显示 refresh token、access token 或完整配置 URL。

![Pan Sync Helper 已安装并处于 ready 状态](docs/images/readme/01-plugin-ready.png)

如果状态不是 `ready`，先按“恢复与安全”处理，不要连续重试文件操作。

### 6. 第一次上传

先确保当前工作区中有演示文件。可以请 OpenClaw 创建它：

```text
在当前工作区创建 pan-sync-demo-en.txt，内容为：Pan Sync Helper demo file.
```

也可以改用工作区中已有的普通文件；后续上传、搜索和下载示例中的文件名与路径要一并替换。然后用明确的上传方向和工作区相对路径请求上传，例如：

```text
把 pan-sync-demo-en.txt 上传到阿里云盘。
```

```text
Upload pan-sync-demo-en.txt to Aliyun Drive.
```

OpenClaw 应调用 `pan_sync_upload`。省略远端目录时上传到 `/openClawShare`；已存在的远端同名文件不会被覆盖。上传目标始终是资源盘。

![上传成功且目标为资源盘](docs/images/readme/02-upload-resource-drive.png)

如果请求还要求先生成文件，例如“生成报告并上传到网盘”，OpenClaw 应先创建并确认文件存在，再执行上传。

### 7. 列出目录或搜索文件

列出资源盘根目录：

```text
列出阿里云盘根目录里的文件。
```

按名称搜索整个资源盘：

```text
在阿里云盘里搜索 pan-sync-demo-en.txt。
```

把范围限制到某个目录时，在请求中给出该网盘目录。OpenClaw 使用 `pan_sync_list`；未指定目录时从 `/` 开始。结果较多时，OpenClaw 只应使用 Tool 返回的 cursor 继续下一页。

![在资源盘中列出或搜索安全演示文件](docs/images/readme/03-search-resource-drive.png)

### 8. 下载并读取

有精确网盘路径时，可直接请求：

```text
下载 /openClawShare/pan-sync-demo-en.txt 到工作区并读取内容。
```

只有文件名时，先搜索再选择：

```text
找到网盘里的 网盘读取示例.txt，下载到工作区并总结。
```

OpenClaw 会先用 `pan_sync_list` 消除歧义，再用 `pan_sync_download` 下载一个普通文件，最后用常规工作区文件工具读取返回的相对 `localPath`。如果有多个匹配项，它应先展示安全的名称、类型、大小和网盘路径并让你选择，不能自行下载。

下载默认保存到当前工作区根目录。若本地已有同名文件，插件不会覆盖它，而是自动使用 `name (1).ext`、`name (2).ext` 等名称。

![下载网盘文件后由 OpenClaw 读取工作区副本](docs/images/readme/04-download-and-read.png)

### 9. 超过 100 MiB 的文件确认

当文件大于 `100 * 1024 * 1024` 字节时，首次下载返回 `DOWNLOAD_CONFIRMATION_REQUIRED`，此时不会创建本地文件。OpenClaw 应显示所选文件的名称和大小，并向你确认：

```text
这个文件超过 100 MiB。确认下载 large-confirmation-demo.bin 吗？
```

只有你对这个文件明确确认后，OpenClaw 才会以 `confirmedLargeDownload: true` 重试一次。确认仅对这一次、这一个文件有效，不会保存，也不能用于另一个文件。

### 10. 恢复、意图安全与凭据安全

- `CREDENTIALS_REQUIRED` 或 `unconfigured`：运行 `openclaw pan-sync configure` 并重新保存有效 refresh token。
- `reauth_required`：在 OpenList 重新授权，取得新的 refresh token 后手动粘贴并保存。
- `degraded` 或 `rate_limited`：等待页面显示的冷却期结束；不要重复提交或循环重试。
- `RESOURCE_DRIVE_UNAVAILABLE`：该账号没有可用资源盘；插件不会改用备份盘。
- 下载中断或失败：未完成的临时文件会被清理；重新请求前先确认网络和状态已恢复。

#### 插件已启用，但当前会话找不到 Tool

插件注册/加载和当前 Agent 的有效 Tool 权限是两个独立环节。`openclaw plugins list` 显示 `enabled` 并列出三个 Tool，只能确认插件已经注册；如果当前会话仍提示 `pan_sync_list` 或 `pan_sync_download` 不可用，还需要把它们加入有效的全局或 Agent 级 Tool 策略。

若要修复全局策略，可在 PowerShell 中运行以下命令。它优先读取全局 `tools.allow`：该路径存在时只合并到原 `allow`，不会设置 `alsoAllow`；否则合并到现有 `tools.alsoAllow`，或从空列表开始。若全局 `tools.deny` 存在，它只移除这两个 Tool 的精确名称并保留其他拒绝项；该路径不存在时不会创建它。最终只提交一个递归对象补丁，因此 `tools` 下的其他键也会保留。不要用仅包含插件 Tool 的固定数组直接执行 `config set` 或 `config patch`，因为数组会被整体替换。

```powershell
$targets = @("pan_sync_list", "pan_sync_download")
$allowJson = openclaw config get tools.allow --json 2>$null
$toolsPatch = @{}
if ($LASTEXITCODE -eq 0) {
  $allow = @((($allowJson -join [Environment]::NewLine) | ConvertFrom-Json))
  $toolsPatch["allow"] = @((
    $allow + $targets
  ) | Sort-Object -Unique)
} else {
  $alsoAllowJson = openclaw config get tools.alsoAllow --json 2>$null
  $alsoAllow = @()
  if ($LASTEXITCODE -eq 0) {
    $alsoAllow = @((($alsoAllowJson -join [Environment]::NewLine) | ConvertFrom-Json))
  }
  $toolsPatch["alsoAllow"] = @((
    $alsoAllow + $targets
  ) | Sort-Object -Unique)
}
$denyJson = openclaw config get tools.deny --json 2>$null
if ($LASTEXITCODE -eq 0) {
  $deny = @((($denyJson -join [Environment]::NewLine) | ConvertFrom-Json))
  $toolsPatch["deny"] = @($deny | Where-Object {
    $_ -ne "pan_sync_list" -and $_ -ne "pan_sync_download"
  })
}
@{ tools = $toolsPatch } |
  ConvertTo-Json -Compress -Depth 3 |
  openclaw config patch --stdin
```

如果当前 Agent 已配置 Agent 级策略，全局授权可能不会成为它的有效权限。此时在 OpenClaw Control UI 中打开 **Settings → Agents → 当前 Agent → Tools**：已有显式 `allow` 时把 `pan_sync_list` 和 `pan_sync_download` 合并到 `allow`，不要再设置 `alsoAllow`；没有显式 `allow` 时可合并到 Agent 级 `alsoAllow`。同时只从 `deny` 中移除这两个精确名称，然后保存。不要删除或替换任何无关授权或拒绝项。

修改任一作用域后，安全重启 Gateway：

```bash
openclaw gateway restart --safe
```

若使用了上面的全局方式，先查询 `tools.allow`；它存在时确认两个 Tool 已加入，脚本不会改动或设置 `alsoAllow`。若 `tools.allow` 不存在，则查询 `tools.alsoAllow`。如果修改前存在 `tools.deny`，还要确认其中只移除了这两个名称：

```powershell
openclaw config get tools.allow --json
openclaw config get tools.alsoAllow --json
openclaw config get tools.deny --json
```

最后新建一个 OpenClaw 会话，分别明确请求列出资源盘根目录和下载读取一个测试文件；旧会话不能代替这次有效权限复验。若使用 Agent 级方式，还应重新打开该 Agent 的 Tools 设置，确认保存的条目仍在。

方向明确时才执行：`同步到网盘` 表示上传，`从网盘同步下来` 表示下载。`同步网盘` 含义不明确，OpenClaw 必须先问你是“上传到网盘”还是“从网盘下载”，不能先调用 Tool。

以下是**仅讨论**的请求，不会上传、列出或下载：

```text
讨论一下把资料放网盘的优缺点。
这个插件能读取哪些网盘文件？
```

不要在聊天、截图或问题报告中粘贴 refresh token、access token、一次性配置地址、下载 URL、drive ID 或 file ID。插件的正常 Tool 输出只返回安全字段和工作区相对路径。

### 11. 已知限制

- 当前只支持 Aliyun Drive 资源盘；不访问备份盘，也不支持其他网盘 Provider。
- 一次只下载一个普通文件，不递归下载目录。
- 搜索是有界、可续页的名称搜索，不是文件内容全文检索。
- 下载需要当前 OpenClaw 会话提供工作区；没有工作区时仍可列出或搜索，但不能下载。
- 大文件确认不会跨 Tool 调用或跨文件复用。

## English quick start

### 1. What the plugin does—and does not do

Pan Sync Helper gives OpenClaw three explicit Aliyun Drive operations:

- `pan_sync_upload` uploads an existing workspace file.
- `pan_sync_list` lists a directory or searches by file name.
- `pan_sync_download` downloads one ordinary cloud file into the current workspace so OpenClaw can read, summarize, or process it with its normal file tools.

Every file operation targets the Aliyun **resource drive** only; the plugin never falls back to the backup drive. Uploads default to `/openClawShare`, listing and search start at the resource-drive root `/`, and downloads default to the current OpenClaw workspace root. The plugin does not recursively download folders or return cloud file contents in Tool output.

### 2. Requirements

- Node.js `22.22.3` or newer.
- OpenClaw `2026.7.1-2` or a compatible newer release.
- An account that can obtain an Aliyun Drive refresh token through OpenList.
- A writable workspace on the current OpenClaw session for downloads.

### 3. Install and enable

Install the published npm package:

```bash
openclaw plugins install openclaw-pan-sync-helper
```

To install from a source checkout, build it first:

```bash
npm install
npm run build
openclaw plugins install .
```

Confirm that the plugin is enabled:

```bash
openclaw plugins list
```

`Pan Sync Helper` should appear as `enabled` and expose all three Tools.

### 4. Configure a refresh token through OpenList

The plugin accepts a manually pasted `refresh_token`. It does not implement QR login or login polling inside the plugin; token acquisition stays on the OpenList page.

1. On the OpenClaw host, run:

   ```bash
   openclaw pan-sync configure
   ```

2. Open the complete one-time loopback URL printed by the command. It expires within ten minutes; never forward, share, or screenshot it.
3. Check the OpenList authorization-page URL on the local setup page. The mainland-China default is `https://api.oplist.org.cn`.
4. Complete Aliyun Drive authorization in OpenList and copy the refresh token it displays.
5. Return to the local setup page, paste only the refresh token, review the complete refresh API URL (default `https://api.oplist.org.cn/alicloud/renewapi`), and save.

A custom refresh API receives the refresh token you paste, so use one only when you trust it. The plugin never rewrites the host, appends a path, or silently selects a fallback service. See the [OpenList authorization and token recovery guide](docs/guides/aliyun-token.md) for the complete trust and recovery model.

### 5. Confirm the `ready` state

After a successful save, the local setup page shows `ready`, meaning the current Aliyun access token can be used for file operations. Normal status and Tool results never reveal refresh tokens, access tokens, or complete configured URLs.

![Pan Sync Helper installed with a safe ready state](docs/images/readme/01-plugin-ready.png)

If the state is not `ready`, follow the recovery section before retrying file operations.

### 6. Make the first upload

First make sure the demo file exists in the current workspace. You can ask OpenClaw to create it:

```text
Create pan-sync-demo-en.txt in the current workspace with this content: Pan Sync Helper demo file.
```

Alternatively, use an existing ordinary workspace file and replace the file name and path consistently in the upload, search, and download examples below. Then state the upload direction and workspace-relative file name:

```text
Upload pan-sync-demo-en.txt to Aliyun Drive.
```

```text
把 pan-sync-demo-en.txt 上传到阿里云盘。
```

OpenClaw should call `pan_sync_upload`. With no remote directory specified, the file goes to `/openClawShare`; an existing remote file is never overwritten. The destination is always the resource drive.

![Successful upload to the resource drive](docs/images/readme/02-upload-resource-drive.png)

For a request such as “create a report and upload it,” OpenClaw should create and verify the file before it starts the upload.

### 7. List or search the drive

List the resource-drive root:

```text
List the files in the root of my Aliyun Drive.
```

Search the whole resource drive by name:

```text
Search Aliyun Drive for pan-sync-demo-en.txt.
```

Name a remote directory in the request to narrow the scope. OpenClaw uses `pan_sync_list` and starts at `/` when no directory is given. If there are more results, it should continue only with the cursor returned by the Tool.

![Listing or searching safe demo files in the resource drive](docs/images/readme/03-search-resource-drive.png)

### 8. Download and read a file

With an exact remote path, ask directly:

```text
Download /openClawShare/pan-sync-demo-en.txt into the workspace and read it.
```

With only a file name, let OpenClaw search first:

```text
Find 网盘读取示例.txt in my drive, download it, and summarize it.
```

OpenClaw uses `pan_sync_list` to resolve ambiguity, calls `pan_sync_download` for one ordinary file, and then reads the returned relative `localPath` with its normal workspace tools. When several files match, it must show safe distinguishing fields—name, type, size, and remote path—and ask you to choose before downloading.

The download goes to the current workspace root by default. If that name already exists locally, the plugin preserves it and chooses `name (1).ext`, `name (2).ext`, and so on.

![OpenClaw reading the downloaded workspace copy](docs/images/readme/04-download-and-read.png)

### 9. Confirm files larger than 100 MiB

For a file larger than `100 * 1024 * 1024` bytes, the first call returns `DOWNLOAD_CONFIRMATION_REQUIRED` and creates no local file. OpenClaw should show the selected name and size and ask:

```text
This file is larger than 100 MiB. Download large-confirmation-demo.bin?
```

Only after your explicit confirmation for that exact file may OpenClaw retry once with `confirmedLargeDownload: true`. The approval is neither saved nor reusable for another file or call.

### 10. Recovery, intent safety, and credential safety

- `CREDENTIALS_REQUIRED` or `unconfigured`: run `openclaw pan-sync configure` and save a valid refresh token again.
- `reauth_required`: authorize again in OpenList, then manually paste and save the new refresh token.
- `degraded` or `rate_limited`: wait for the displayed cooldown; do not submit or retry in a loop.
- `RESOURCE_DRIVE_UNAVAILABLE`: the account has no usable resource drive; the plugin will not switch to backup storage.
- Interrupted or failed download: incomplete temporary output is cleaned up; verify the network and status before retrying.

#### The plugin is enabled, but the current session cannot find a Tool

Plugin registration/loading and the active Agent's effective Tool policy are separate gates. Seeing `enabled` and all three Tools in `openclaw plugins list` confirms registration only. If the current session still reports that `pan_sync_list` or `pan_sync_download` is unavailable, add them at the effective global or Agent scope.

To repair the global policy, run the following in PowerShell. It reads global `tools.allow` first. If that path exists, it merges into the existing `allow` only and does not set `alsoAllow`; otherwise, it merges into the existing `tools.alsoAllow` or starts with an empty list. When global `tools.deny` exists, it removes only the two exact Tool names and preserves every other denial; it does not create that path when absent. One recursive object patch preserves all sibling keys under `tools`. Do not run `config set` or `config patch` with a fixed array containing only the plugin Tools: arrays are replaced as a whole.

```powershell
$targets = @("pan_sync_list", "pan_sync_download")
$allowJson = openclaw config get tools.allow --json 2>$null
$toolsPatch = @{}
if ($LASTEXITCODE -eq 0) {
  $allow = @((($allowJson -join [Environment]::NewLine) | ConvertFrom-Json))
  $toolsPatch["allow"] = @((
    $allow + $targets
  ) | Sort-Object -Unique)
} else {
  $alsoAllowJson = openclaw config get tools.alsoAllow --json 2>$null
  $alsoAllow = @()
  if ($LASTEXITCODE -eq 0) {
    $alsoAllow = @((($alsoAllowJson -join [Environment]::NewLine) | ConvertFrom-Json))
  }
  $toolsPatch["alsoAllow"] = @((
    $alsoAllow + $targets
  ) | Sort-Object -Unique)
}
$denyJson = openclaw config get tools.deny --json 2>$null
if ($LASTEXITCODE -eq 0) {
  $deny = @((($denyJson -join [Environment]::NewLine) | ConvertFrom-Json))
  $toolsPatch["deny"] = @($deny | Where-Object {
    $_ -ne "pan_sync_list" -and $_ -ne "pan_sync_download"
  })
}
@{ tools = $toolsPatch } |
  ConvertTo-Json -Compress -Depth 3 |
  openclaw config patch --stdin
```

If the active Agent has an Agent-level policy, the global grant might not become effective for that Agent. In the OpenClaw Control UI, open **Settings → Agents → active Agent → Tools**. With an explicit `allow`, merge `pan_sync_list` and `pan_sync_download` into `allow` and do not also set `alsoAllow`; without an explicit `allow`, merge them into the Agent-level `alsoAllow`. Remove only these two exact names from `deny`, then save. Preserve every unrelated grant and denial.

After changing either scope, restart the Gateway safely:

```bash
openclaw gateway restart --safe
```

For the global method, query `tools.allow` first. If it exists, confirm the two Tools are present; the script does not change or set `alsoAllow`. If `tools.allow` is absent, query `tools.alsoAllow`. If `tools.deny` existed before the change, also confirm that only the two Tool names were removed:

```powershell
openclaw config get tools.allow --json
openclaw config get tools.alsoAllow --json
openclaw config get tools.deny --json
```

Finally, start a fresh OpenClaw session and explicitly request a resource-drive root listing and a test-file download/read. An old session does not replace this effective-policy check. For the Agent-level method, also reopen that Agent's Tools settings and confirm that the saved entries remain present.

Directional sync is explicit: `sync to cloud drive` means upload, while `sync from cloud drive` means download. `sync cloud drive` is ambiguous, so OpenClaw must ask whether you mean upload or download before it calls a Tool.

These are **discussion-only** requests and must not upload, list, or download anything:

```text
Let's discuss whether cloud storage is useful.
What kinds of cloud files could this plugin read?
```

Never paste a refresh token, access token, one-time configuration URL, download URL, drive ID, or file ID into chat, screenshots, or issue reports. Normal Tool results expose only safe fields and workspace-relative paths.

### 11. Known limitations

- Only the Aliyun Drive resource drive is supported; the backup drive and other providers are out of scope.
- Downloads handle one ordinary file at a time and never recurse through a folder.
- Search is a bounded, resumable name search, not full-text search inside file contents.
- Downloads require a workspace on the current OpenClaw session. Listing and search still work without one.
- Large-file confirmation is never retained across Tool calls or reused for another file.
