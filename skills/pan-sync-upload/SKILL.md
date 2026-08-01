---
name: pan-sync-upload
description: Upload concrete OpenClaw workspace files when the user explicitly asks to push, upload, or sync results to a cloud drive.
---

# 网盘上传

仅在用户明确要求上传、同步或推送文件到网盘时调用 `pan_sync_upload`。`阿里网盘`、`阿里云盘`、`aliyun`、`alipan` 均映射到 Provider `aliyun`。用户使用明确的上传、同步或推送动词并提到“网盘”但未指定 Provider 时，使用默认 Provider。

仅讨论网盘、云盘功能或网盘中通常存放什么内容时，不调用 Tool，也不要把讨论推断为上传请求。

如果请求同时要求创建产物和上传，先生成请求的产物，确认路径确实存在，再调用 Tool。不得虚构路径；同一请求中的同一规范化文件不得重复上传。

如果 Tool 返回 `CREDENTIALS_REQUIRED`，请用户打开 Pan Sync Helper 状态标签页，并运行配置命令 `openclaw pan-sync configure`。

Pan Sync Helper authorization uses OpenList. In the local setup page, use the default mainland-China page `https://api.oplist.org.cn`, select Aliyun Drive App Login, and paste only the resulting refresh token. The complete refresh API URL is independently editable; a custom URL receives that refresh token and has no automatic fallback. OpenList is only for authorization and token refresh: files upload directly to Aliyun.
