# OpenList Token Service Final Fix Round 4 Report

- 日期：2026-08-02
- 审查基线：`11c3287c1e5b652f9f3fe1fcdc4e1b7810ccbe47`
- 修复提交：`9217f6884060106d47ba3a9f20e20b7c25cf7a96`
- 范围：仅修复 `bindFetchSafeLoopbackServer()` 在端口安全 predicate 抛错时的 candidate listener 生命周期
- 未改范围：上传、Token、Bearer、signed PUT、OpenList/Aliyun 业务逻辑与外部发布门禁

## 根因

`waitUntilListening()` 成功后，helper 直接调用可注入的 `isPortSafe`。predicate 抛错时，控制流在 `closeListeningServer()` 之前离开；调用方只能收到 predicate 异常，却拿不到已监听 candidate 的句柄。`startSetupServer()` 也只在 helper 成功返回后才给外层 `server` 赋值，因此 setup catch 无法补救该 listener 泄漏。

修复前的独立 probe 得到：predicate 原异常身份保持，但 candidate 仍为 `listening=true`，并保有真实 IPv4 loopback 地址。

## RED

在 `tests/unit/fetch-safe-loopback.test.ts` 增加两个确定性回归：

1. predicate 抛唯一 canary Error；调用必须以同一 Error 对象拒绝，并且拒绝前 candidate 已触发 `close`、`listening=false`、`address()=null`。
2. candidate 执行真实 close 后，close callback 再注入独立 cleanup Error；helper 仍须等待 cleanup settle，并保持 predicate Error 为 primary，不得由 cleanup Error 覆盖。

修复前运行 helper unit：4 个用例中既有 2 个通过，新增 2 个均因 `closeCompleted` 仍为 `false` 而失败，失败原因与泄漏根因一致。

## GREEN

仅在 predicate 求值处增加异常清理边界：

- 正常返回 `true` 或 `false` 的路径保持原样。
- predicate 抛出任意值时，先 `await closeListeningServer(server)`。
- cleanup attempt 成功或失败后，都原样重抛 predicate 异常；cleanup Error 是 secondary，不能替换 primary 异常身份。
- 没有修改固定端口拒绝、ephemeral rebind、地址不可用、普通 close 失败或最多 16 次选择耗尽语义。

GREEN 后 helper unit 4/4 通过；最终针对编译产物的 probe 得到：`sameError=true`、`closeCompleted=true`、`listening=false`、`address=null`。

## 其他异常路径核对

- `createServer()` 或 listen 失败仍直接拒绝，未进入端口策略与 rebind。
- `server.address()` 不可用时仍先 close，再抛既有地址错误。
- predicate 返回 `false` 时仍先 await close；普通 close 失败仍中止 rebind 并向上拒绝。
- 非零固定端口仍只尝试一次，close 后抛既有 fixed-port 错误。
- ephemeral 端口仍只在 candidate 已成功 close 后重绑，最多创建并检查 16 个 candidate，随后抛既有 exhausted 错误。

## 验证

运行环境：Node.js 22.23.1。

- 聚焦 loopback/upload/setup：3 个文件，55/55 通过。
- 完整 unit：14 个文件，225 通过，1 个既有 Win32 平台 skip。
- 完整 integration：9 个文件，102/102 通过。
- fresh `npm run verify`：typecheck、unit、integration、build、pack dry-run 全部通过。
- 独立 `npm pack --dry-run --json`：84 个文件；包含 `dist/net/fetch-safe-loopback.{d.ts,js,js.map}`，0 个 test 文件，未留下 `.tgz`。
- listener 最终 probe：candidate 已关闭且无地址。
- `pan-sync-package-fixture-*` 临时目录：0。系统临时目录中另有 14 个在本轮开始前已存在的 `pan-sync-*` 目录，本轮没有新增，未删除用户既有残留。
- `git diff --check`：PASS。

## 疑虑与外部门禁

- cleanup Error 在 predicate Error 已发生时仅作为 secondary 故障处理，不覆盖调用方必须收到的原始 predicate 异常；该优先级由确定性测试固定。
- installed-browser `pagehide` 证据、真实 OpenList/Aliyun 账号验收与既有 Release BLOCKED 结论未在本轮改写，仍是独立外部门禁。
- 未合并、未推送、未发布，未执行真实账号操作。
