# OpenClaw Pan Sync Helper

Pan Sync Helper lets OpenClaw upload existing workspace files directly to one Aliyun Drive account. It calls the upload tool only for an explicit upload, sync, or push request. Files, folder queries, and upload data go directly between the plugin and Aliyun Drive; OpenList is used only for authorization and token refresh.

The default upload directory is `/openClawShare`. Existing remote names are not overwritten.

## Install and enable

Install the published package on the OpenClaw host:

```bash
openclaw plugins install openclaw-pan-sync-helper
```

The install command registers and enables the plugin. For a local source checkout, build it first and then install that checkout:

```bash
npm install
npm run build
openclaw plugins install .
```

The regular plugin configuration only accepts `defaultDirectory`; authorization data is kept out of regular plugin configuration.

## Configure Aliyun Drive through OpenList

1. On the host running OpenClaw, run:

   ```bash
   openclaw pan-sync configure
   ```

2. Open the complete one-time loopback URL printed by the command. It is available for at most ten minutes. Keep the final `#<one-time-key>` fragment when opening it; the page moves that key into browser session storage and removes it from the visible address after loading.
3. The default mainland-China OpenList authorization page is `https://api.oplist.org.cn`. Open it, or edit the **authorization page URL** first if you intentionally use another service.
4. In OpenList, select **Aliyun Drive App Login**, scan the code, and copy the resulting **refresh token**.
5. Paste only that refresh token into the setup page. Review the complete **refresh API URL**—by default `https://api.oplist.org.cn/alicloud/renewapi`—and edit it if needed, then save.

Both URLs are complete, independent values. A custom HTTP, intranet, public, or third-party refresh URL receives the refresh token you paste. Choose it only when you trust that service. The plugin never silently switches to another service or falls back to another URL.

The first save calls the configured OpenList refresh API once to validate and store the returned tokens. Later operation is passive: the plugin refreshes only after Aliyun Drive explicitly rejects the current access token. It does not refresh from a local expiry guess. Rate limits and temporary failures enter a persisted cooldown rather than causing immediate retries.

## Connection states and recovery

The status page exposes only these states:

- `unconfigured`: no usable OpenList authorization has been saved.
- `ready`: the stored Aliyun access token can be used.
- `degraded`: OpenList was temporarily unavailable and is cooling down.
- `rate_limited`: OpenList returned a rate limit and is cooling down.
- `reauth_required`: the refresh token was rejected or no longer satisfies the OpenList response contract.

For `reauth_required`, revoke the old Aliyun Drive authorization if appropriate, then repeat the OpenList scan and paste a newly obtained refresh token. For `degraded` or `rate_limited`, wait for the displayed service condition to clear; do not repeatedly submit the same token.

## Safe upload requests

Examples that can call the upload tool:

```text
把 report.pdf 推送到阿里网盘
把刚生成的结果上传到 aliyun
生成报告并把结果推送到网盘
```

The final example creates the report first and uploads it only after the file exists. A question such as `网盘里一般放什么文件？` is only a discussion and does not upload anything.

## Security notes

- The setup page is loopback-only and uses a one-time key. Do not expose it to a network or share its full URL.
- The authorized setup page can display the complete refresh token and both URLs. Do not share them, screenshots, or browser sessions with others.
- The status page and upload tool do not reveal refresh tokens, access tokens, or complete configured URLs.
- OpenList does not proxy file content. Uploads remain direct to Aliyun Drive.

For a detailed authorization and recovery walkthrough, see [the OpenList token guide](docs/guides/aliyun-token.md).
