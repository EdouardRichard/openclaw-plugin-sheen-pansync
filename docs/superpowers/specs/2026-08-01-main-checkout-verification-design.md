# Main Checkout Verification Hardening Design

- 日期：2026-08-01
- 状态：已批准
- 范围：合并后的 Windows 主检出验证稳定性

## 背景

`feature/pan-sync-helper-v0.1` 已快进合并到 `main`。在主检出执行 `npm run verify` 时发现两个仅由检出环境触发的问题：

1. 仓库内保留的 `.worktrees/pan-sync-helper-v0.1` 被 Vitest 当作第二份测试根目录，导致测试重复执行，并让两个真实 OpenClaw 安装测试争用同一资源。
2. Windows 的 `core.autocrlf=true` 将 `skills/pan-sync-upload/SKILL.md` 检出为 CRLF，而 OpenClaw Skill frontmatter 合约要求稳定的 LF 字节。

功能分支在其独立工作区内的完整验证已通过；本次修复只处理仓库基础设施隔离和跨平台文本规范，不修改插件业务行为。

## 已批准方案

### 1. 仓库内 worktree 不参与测试发现

在 `vitest.config.ts` 中从 `vitest/config` 导入 `configDefaults`，保留 Vitest 自带的排除项，并追加：

- `**/.worktrees/**`
- `**/worktrees/**`

这样无论项目使用隐藏或非隐藏的仓库内 worktree 目录，测试都只发现当前检出的测试文件。不得通过移动 worktree、临时删除目录或缩小 `npm run verify` 范围来掩盖问题。

### 2. Skill 文件强制使用 LF

新增 `.gitattributes`，仅对 `skills/**/SKILL.md` 声明 `text eol=lf`。该范围覆盖当前及后续 Provider Skill，同时避免无必要地改写所有 Markdown 文件。

当前检出的 `skills/pan-sync-upload/SKILL.md` 需要做一次纯换行规范化；内容不得改变。现有 frontmatter 合约测试继续严格要求 LF，不放宽为同时接受 CRLF。

## 测试策略

遵循 TDD：

1. 以合并后主检出的失败结果作为 RED 基线：测试数量翻倍、真实安装测试争用、Skill frontmatter 因 CRLF 失败。
2. 增加配置契约测试，断言 Vitest 配置保留默认排除项并排除两种仓库内 worktree 路径。
3. 增加 Git 属性契约测试，断言 Skill 文件模式明确固定为 LF；保留现有 Skill frontmatter 字节测试。
4. 最小修改 `vitest.config.ts`、`.gitattributes` 并规范化当前 Skill 文件。
5. 在嵌套 feature worktree 仍存在时运行完整 `npm run verify`，确认测试不再重复发现且所有门禁通过。

## 非目标

- 不修改上传、Token 刷新、凭证、CLI、Control UI 或 OpenClaw 集成逻辑。
- 不放宽 Skill frontmatter 格式。
- 不删除或强制清理任何 worktree 来代替配置修复。
- 不改变真实阿里云盘验收和 OpenClaw 集成 smoke 的既有阻塞结论。

## 完成标准

- worktree 排除和 Skill LF 规则有自动化回归测试。
- 嵌套 `.worktrees/pan-sync-helper-v0.1` 保持存在时，主检出完整 `npm run verify` 通过，测试数量恢复为单份。
- Git diff 无空白错误，业务代码无改动。
- 完成代码审查后，才允许执行既定的 feature worktree 和 feature 分支清理。
