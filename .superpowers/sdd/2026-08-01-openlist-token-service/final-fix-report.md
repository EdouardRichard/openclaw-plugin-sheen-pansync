# OpenList Token Service Final Fix Report

- 日期：2026-08-02
- 审查基线：`2bd0cdb6217cab6f3bb3bfed09727d8d7423c1bb`
- 修复提交：`d966ef66b354ad7ccbc394b401f2d1ed36329ff6`
- 范围：最终代码审查中的 2 个 Important 与 2 个 Minor
- 边界：未改变既有 URL/fetch 信任边界、Token 泄漏边界、Aliyun 直传架构或发布验收结论；未执行真实账号验收。

## 结论

四项审查发现均已修复并由聚焦测试覆盖。Node.js 22.23.1 下的 fresh `npm run verify` 通过：unit 221 通过、1 个既有 Win32 平台 skip；integration 101 通过；build 与 npm pack dry-run 通过，包共 81 个文件。

## Important 1：Retry-After 持久冷却边界

### RED

命令：

```text
volta run --node 22.23.1 npm exec -- vitest run tests/unit/openlist-token-service.test.ts tests/unit/token-manager.test.ts
```

修复前新增边界用例得到 4 个预期失败：

- `Retry-After: 0` 在服务层正确解析为 0，但 TokenManager 错误地改用 60 分钟 fallback。
- 秒值 `9007199254741` 本身为 safe integer，乘 1000 后不再安全，服务仍向下传递。
- 秒值 `8640000000000` 乘 1000 后仍是 safe integer，但 `now + delay` 超出 JavaScript Date 范围，服务仍向下传递。
- TokenManager 对超出 Date 范围的延迟执行 `toISOString()` 时抛出 RangeError，外层转成 `TOKEN_ENDPOINT_UNAVAILABLE`，且没有持久化 429 冷却。

RED 结果：2 个测试文件，47 通过、4 失败；失败内容与上述根因完全一致。

### GREEN

- 服务端 delta-seconds 依次验证秒值、毫秒乘积以及最终绝对时间；无效元数据交由 TokenManager 使用 60 分钟 fallback。
- TokenManager 接受零延迟，持久化 `notBefore` 等于当前 clock。
- TokenManager 在构造 Date 前验证延迟与绝对时间；异常的大值安全回退，不再抛 RangeError 或丢失持久冷却。

GREEN 结果：2 个测试文件，51/51 通过。

## Important 2：refresh lease waiter 预算

### RED

增加无需真实等待 15 秒的确定性并发模型：winner 的合法上游请求与提交临界区在逻辑时间 15,001ms 完成，waiter 使用原 15,000ms acquisition budget 时先收到 `credential lease unavailable`，无法读取 winner。

命令：

```text
volta run --node 22.23.1 npm exec -- vitest run tests/unit/sqlite-worker-lease.test.ts
```

RED 结果：12 个用例中 10 通过、2 失败；并发 waiter 用例失败，且 Worker factory 仍观察到 15,000ms 默认预算。

### GREEN

- 默认 lease acquisition budget 改为 30,000ms。
- 该预算严格大于固定的 15,000ms OpenList request timeout，并为 Vault 预读、CAS/文件系统提交和 lease 释放保留另外 15 秒余量。
- 确定性并发用例验证 winner 在 15 秒请求边界后完成提交时 waiter 仍存活并取得 winner；既有真实跨进程成功和 429 single-flight 用例继续通过。

GREEN 结果：SQLite lease unit 与跨进程 integration 共 14/14 通过。

## Minor 1：child process stdio 排空

- `startChild` 在进程启动时立即订阅 `close`，避免结束过快导致漏接事件。
- 两个 child 的 `close` 均完成后，先严格断言 `{ code: 0, signal: null }`，再断言累计 stderr 为空。
- `NODE_OPTIONS` 继续禁用已知 `ExperimentalWarning`；任何其他 stderr 输出仍会使测试失败。

GREEN 结果：跨进程 integration 2/2 通过。此项修复的是测试观察边界；旧实现虽可偶然通过，但其 `exitCode` 轮询在 Node stdio `close` 前没有完整 stderr 保证。

## Minor 2：packed README 本地 guide

### RED

package integration 新增 tarball 门禁后，修复前得到 3 个预期失败：npm 文件清单缺少 guide、packed README 本地链接无法读取、guide 无法纳入用户文档泄漏检查。

### GREEN

- 采用最小一致方案：仅将 `docs/guides/aliyun-token.md` 加入 npm `files` 白名单，README 链接不改为不稳定外部地址。
- 门禁从实际 tarball 读取 README，枚举其全部本地 Markdown 目标并逐一验证可从包中读取。
- shipped guide 同时纳入个人 OAuth 凭证指导泄漏检查。

GREEN 结果：package integration 7/7 通过；npm pack dry-run 明确包含该 guide。

## 完整验证

最终 fresh 命令：

```text
volta run --node 22.23.1 npm run verify
```

结果：

- typecheck：PASS。
- unit：13 个文件，221 通过，1 个既有 Win32 平台 skip。
- integration：8 个文件，101 通过。
- build：PASS。
- npm pack dry-run：PASS，81 个文件，包含 `docs/guides/aliyun-token.md`。
- `git diff --check`：PASS。

首次完整 verify 曾出现一次与本次修复无关的并行测试构建竞态：`package.test.ts` 与 `plugin-entry.test.ts` 同时执行 build，并发清理未跟踪 `dist/admin` 时 Windows 返回 `ENOTEMPTY`，继而造成包文件缺失的连锁失败。随后完整 integration 101/101 通过，之后 fresh `npm run verify` 全部通过；未为该非稳定、非本次范围问题改动代码。

## 疑虑与外部门

- 30 秒 lease 预算覆盖 15 秒网络上限并提供 15 秒本地提交余量；若宿主文件系统异常阻塞超过该余量，waiter 仍会返回稳定的 lease unavailable 错误，这是有界等待的保留行为。
- installed-package browser pagehide 证据、真实 OpenList/Aliyun 账号验收及既有 release BLOCKED 结论均未在本次代码修复中改写，仍属于独立外部门。
- 未合并、未推送、未发布，也未执行真实账号操作。
