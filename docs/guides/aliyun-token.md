# 阿里云盘初始 Refresh Token 指南

Pan Sync Helper 需要一组彼此匹配的 OAuth 凭证：Client ID、Client Secret 和初始 Refresh Token。插件只接受你自己的阿里云盘开放平台 OAuth 应用；运行时由插件直接调用阿里云盘官方端点刷新令牌。

## 支持边界

```text
AList public/default client mode          -> not supported by this plugin
AList custom Client ID + Client Secret    -> acceptable source of the initial token
Other trusted custom-client tools         -> acceptable
Plugin runtime refresh                    -> official Aliyun endpoint, no AList dependency
```

不要把 AList 公共/默认客户端模式获取的 Token、公共 Token 服务的 Token，或其他 OAuth 应用签发的 Token 填入插件。它们与自定义 Client ID/Client Secret 不匹配，插件不会用它们替换现有有效凭证。

## 使用 AList 的自定义客户端模式

请遵循 [AList Aliyundrive Open 文档](https://alist-repo.github.io/docs/guide/drivers/aliyundrive_open.html) 中关于自定义 Client ID 和 Client Secret 的说明。该文档明确指出：使用自己的开发者应用时，OAuth Token 获取也必须改为使用自己的开发者应用 ID 与密钥。

在 AList 中选择自定义 Client ID + Client Secret，而不是留空让 AList 使用默认客户端；再以这同一个 OAuth 应用完成授权并取得初始 Refresh Token。AList 只是可选的初始 Token 来源，不是 Pan Sync Helper 的服务依赖：配置完成后不需要运行 AList，也不会向 AList 请求刷新。

## 其他可信自定义客户端工具

也可以使用其他可信工具，前提是工具允许你输入自己的 Client ID 和 Client Secret，并且用这对凭证完成 OAuth 授权与换取 Token。不要使用要求共享你的 Client Secret、返回公共客户端 Token，或无法确认 Token 所属 OAuth 应用的工具。

## 提交前的匹配检查

提交到 `openclaw pan-sync configure` 前，逐项确认：

1. Client ID 来自你注册的阿里云盘开放平台应用。
2. Client Secret 是该 Client ID 对应的密钥。
3. Refresh Token 是用上述同一 Client ID 和 Client Secret 完成授权后取得的。

随后在运行 OpenClaw 的主机上执行：

```bash
openclaw pan-sync configure
```

仅在命令打开的、经一次性访问密钥授权的 `127.0.0.1` 配置页填写三项值。必须完整打开命令打印的 URL（包括 URL fragment 中的 `#<one-time-key>`）；页面加载时会立即把有效密钥移入浏览器的 `sessionStorage`，再从可见地址栏移除 fragment。选择“Save and verify”后，插件会直接用阿里云盘官方刷新端点验证凭证；成功时加密保存，失败时保留旧凭证。

## 令牌失效或泄露后的恢复

若出现授权撤销、Refresh Token 被拒绝或泄露：先在阿里云盘侧撤销旧授权，重新用同一个自定义 OAuth 应用取得初始 Refresh Token，然后再次运行配置命令。不要尝试改用 AList 默认客户端、AList 刷新服务或公共刷新服务来恢复。
