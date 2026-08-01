# OpenList authorization and refresh-token guide

Pan Sync Helper uses OpenList to obtain and refresh Aliyun Drive tokens. It does not ask you to create or enter personal OAuth application credentials. You authorize in OpenList, then paste only the refresh token into the plugin's local setup page.

## Default mainland-China URLs

The setup page starts with these independent, complete values:

| Field | Default |
| --- | --- |
| OpenList authorization page URL | `https://api.oplist.org.cn` |
| OpenList refresh API URL | `https://api.oplist.org.cn/alicloud/renewapi` |

Use the defaults for the mainland-China OpenList service. You may replace either field with a global or custom URL. The plugin sends the pasted refresh token only to the complete refresh API URL that is currently saved; it does not add a path, rewrite a host, or select a fallback node.

Custom URLs can be HTTP, intranet, public, or third-party services. That flexibility is intentional, but it changes who can receive your refresh token. Verify the full address and trust boundary before saving. A custom authorization page and refresh API do not have to share a host.

## Authorize and save

1. Run `openclaw pan-sync configure` on the OpenClaw host.
2. Open the full one-time loopback URL printed by the command, including its `#<one-time-key>` fragment.
3. Review the authorization page URL. Open the default OpenList page, or edit it before opening a different trusted page.
4. In OpenList, choose **Aliyun Drive App Login**, scan the code, and copy the refresh token that OpenList displays.
5. Return to the setup page. Paste only the refresh token, review or edit the complete refresh API URL, and save.

The setup page is authorized by the one-time URL and intentionally re-displays the complete refresh token and both URLs while you are configuring it. Treat that page as sensitive: do not screen-share it, save screenshots, or share the URL. Outside that authorized page, the plugin keeps these values out of normal configuration, status output, Tool results, logs, and errors.

The first successful save calls the selected OpenList refresh API once, verifies the returned Aliyun account, and stores the rotated tokens atomically. Later the plugin does not refresh proactively: it calls OpenList only after Aliyun Drive explicitly reports that the current access token is invalid. Aliyun Drive file operations and file bytes still go directly to Aliyun Drive.

## States, cooldowns, and reauthorization

- `ready`: uploads can use the current access token.
- `degraded`: a network failure, timeout, or OpenList 5xx response started a short persisted cooldown.
- `rate_limited`: OpenList returned 429 and started a persisted rate-limit cooldown.
- `reauth_required`: the refresh token was rejected or OpenList did not return both required tokens.
- `unconfigured`: no valid authorization is stored.

During `degraded` or `rate_limited`, wait for the cooldown instead of repeatedly retrying. The plugin does not send an immediate automatic retry.

For `reauth_required`, revoke the old Aliyun Drive authorization if it may be exposed or invalid, repeat the OpenList scan, copy a new refresh token, and save it through `openclaw pan-sync configure`. A successful explicit save clears the prior failure state; a failed save keeps the previously stored authorization unchanged.
