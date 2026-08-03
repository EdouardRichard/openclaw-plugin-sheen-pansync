---
name: pan-sync-upload
description: Upload, list, search, download, and read Aliyun Drive files from OpenClaw when the user explicitly requests a cloud-drive operation in Chinese or English.
---

# Pan Sync 阿里云盘文件操作

## Provider aliases / 网盘别名

`阿里网盘`、`阿里云盘`、`aliyun`、`alipan` and `Aliyun Drive` all mean Provider `aliyun`. All file operations target the Aliyun **resource drive / 资源盘** only, never the backup drive. If an explicit cloud-drive operation omits the Provider, use the configured default.

## Upload / 上传

For explicit upload intent such as “上传”, “推送到网盘”, “传到阿里云盘”, “保存到网盘”, “upload”, “push to cloud drive”, “send a file to Aliyun Drive”, “save a result to the cloud drive”, or a directional sync-to request, call `pan_sync_upload` with existing workspace-relative `paths`, optional `provider`, and optional `remoteDirectory`.

If the request also creates an artifact, create it first, verify that its path exists, then upload it. Never invent a path or upload the same normalized file twice in one request.

## List and search / 列出与搜索

For “列出/查看/浏览网盘目录”, “list/show/browse files”, “搜索/查找”, or “search/find”, call `pan_sync_list`:

- List: pass `remoteDirectory`; omit it or use `/` for the resource-drive root.
- Search: pass `query`; optionally pass `remoteDirectory` to narrow the subtree.
- Continue pagination only with the returned `cursor` when more results are needed.

## Download and read / 下载与读取

For “下载/获取网盘文件”, “从网盘取出并保存到工作区”, “读取/打开/总结网盘文件”, “download/fetch a cloud file”, “get a file from the cloud drive”, “read/open/summarize a cloud file”, or a directional sync-from request, use `pan_sync_download` for one ordinary file. After a successful download, use OpenClaw's normal workspace file tools to read or process the returned relative `localPath`.

Do not treat a directory as a downloadable file. Omit `localDirectory` to download to the current workspace root. Existing local files are not overwritten; the Tool chooses a collision-safe name such as `name (1).ext`.

## Exact path or query / 精确路径或搜索词

- If the user supplies one exact remote path, call `pan_sync_download` with `remotePath`.
- If the user supplies only a name or search phrase, call `pan_sync_list` with `query` first, then download the selected result by `fileId`.
- If exactly one ordinary file matches, it may be selected. If multiple files match, show safe distinguishing fields and ask the user to select one; do not call `pan_sync_download` until they choose.

## Large-file confirmation / 大文件确认

If `pan_sync_download` returns `DOWNLOAD_CONFIRMATION_REQUIRED`, no file has been downloaded. Tell the user the selected file name and size and ask for explicit confirmation because it is more than 100 MiB. After one explicit confirmation for that exact file, retry `pan_sync_download` exactly once with the same `fileId` or `remotePath` and `confirmedLargeDownload: true`. Never reuse the confirmation for a different file. If that confirmed retry returns the same code again, stop and report the failure instead of asking again or retrying in a loop.

## Directional sync / 同步方向

- `同步到网盘` and `sync to cloud drive` mean upload: call `pan_sync_upload`.
- `从网盘同步下来` and `sync from cloud drive` mean download: follow the exact-path-or-query flow and call `pan_sync_download` only after one file is identified.
- `同步网盘` and `sync cloud drive` are ambiguous: 必须先询问澄清 whether the user means upload to the drive or download from it. Do not call a Tool before clarification.

## Discussion-only requests / 仅讨论

Capability questions and hypothetical discussion are not execution requests. For example, “讨论一下把资料放网盘的优缺点”只需回答，**不调用** Tool; “Let's discuss whether cloud storage is useful” must not call a Tool. Likewise, answer “这个插件能读取哪些网盘文件？” or “What could this plugin read?” without starting a list or download unless the user explicitly asks to perform one.

## Credential recovery / 凭据恢复

If any Tool returns `CREDENTIALS_REQUIRED`, do not keep retrying. Ask the user to open the Sheen PanSync status tab and run `openclaw pan-sync configure`.

Authorization uses OpenList. On the local setup page, use the default mainland-China page `https://api.oplist.org.cn`, select Aliyun Drive App Login, and paste only the resulting refresh token. The complete refresh API URL is independently editable; a custom URL receives that refresh token and has no automatic fallback. OpenList is only for authorization and token refresh; uploads go directly to Aliyun's resource drive and downloads come directly from it.
