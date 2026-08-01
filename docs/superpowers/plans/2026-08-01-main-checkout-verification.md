# Main Checkout Verification Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan. Follow superpowers:test-driven-development and superpowers:verification-before-completion.

**Goal:** Make the merged `main` checkout verify deterministically on Windows while a repository-local worktree exists.

**Architecture:** Treat repository-local worktrees as infrastructure outside Vitest discovery, preserving Vitest defaults via `configDefaults`. Make OpenClaw Skill frontmatter byte-stable across Git checkouts with a narrowly scoped `.gitattributes` rule.

**Tech Stack:** Node.js 22.23.1 via Volta, TypeScript ESM, Vitest 3.2, Git attributes, PowerShell.

## Constraints

- Do not modify plugin business behavior.
- Do not loosen the LF-only Skill frontmatter contract.
- Do not remove the nested feature worktree until verification passes with it still present.
- Do not stage `dist/`, `node_modules/`, or unrelated files.
- Preserve Vitest's default excludes when adding repository-local worktree excludes.

---

## Task 1: Isolate repository-local worktrees and normalize Skill files

**Files:**

- Create: `.gitattributes`
- Create: `tests/unit/repository-config.test.ts`
- Modify: `vitest.config.ts`
- Normalize only: `skills/pan-sync-upload/SKILL.md`

### Step 1: Add failing repository configuration tests

Create `tests/unit/repository-config.test.ts` with two focused contracts:

1. Import `vitest.config.ts` and assert `test.exclude` contains every entry from `configDefaults.exclude` plus `**/.worktrees/**` and `**/worktrees/**`.
2. Read `.gitattributes` and assert it contains the exact non-comment rule `skills/**/SKILL.md text eol=lf`.

The tests must inspect observable repository configuration rather than duplicating helper logic.

### Step 2: Run the focused test and verify RED

Run:

```powershell
volta run --node 22.23.1 npm exec -- vitest run tests/unit/repository-config.test.ts
```

Expected: FAIL because `test.exclude` is absent and `.gitattributes` does not exist. Record the failure reasons; do not proceed unless they match the intended missing behavior.

The earlier merged-main `npm run verify` failure is additional RED evidence for the end-to-end defects: duplicated test discovery and CRLF Skill frontmatter.

### Step 3: Implement the minimal configuration changes

Update `vitest.config.ts`:

```ts
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    restoreMocks: true,
    clearMocks: true,
    testTimeout: 15_000,
    exclude: [
      ...configDefaults.exclude,
      "**/.worktrees/**",
      "**/worktrees/**",
    ],
  },
});
```

Create `.gitattributes` containing:

```gitattributes
skills/**/SKILL.md text eol=lf
```

Normalize only `skills/pan-sync-upload/SKILL.md` from CRLF to LF without changing its text. Use an exact-file formatting operation, then verify its bytes contain no CRLF.

### Step 4: Run focused GREEN tests

Run:

```powershell
volta run --node 22.23.1 npm exec -- vitest run tests/unit/repository-config.test.ts tests/integration/tool.test.ts
```

Expected: PASS. Confirm the Skill discovery contract still enforces the approved frontmatter and trigger guidance.

### Step 5: Run the complete gate while the nested worktree still exists

First confirm the feature worktree exists:

```powershell
git worktree list
```

Then run:

```powershell
volta run --node 22.23.1 npm run verify
git diff --check
git status --short
```

Expected:

- Typecheck passes.
- Unit suite runs one copy of the repository tests, plus the new repository configuration tests; it does not discover `.worktrees/**`.
- Integration suite runs one copy and the official OpenClaw install test no longer contends with a duplicate.
- Build and package dry-run pass.
- Only the intended source/test/config files are staged or modified; generated `dist/` and `node_modules/` remain untracked and unstaged.

### Step 6: Commit the implementation

Stage only:

```powershell
git add -- .gitattributes vitest.config.ts tests/unit/repository-config.test.ts skills/pan-sync-upload/SKILL.md
git diff --cached --check
git commit -m "test: harden main checkout verification"
```

If the normalized Skill blob is unchanged in Git because HEAD already stores LF, it need not appear in the commit; `.gitattributes` must still be committed.

### Step 7: Review and finish the local merge workflow

Request a fresh code review of the Task 1 commit. Address findings with the same RED/GREEN discipline and rerun the complete gate after any change.

Only after review and a fresh passing `npm run verify`:

1. Remove the completed `pan-sync-helper-v0.1` worktree using the normal non-force worktree removal path.
2. Delete `feature/pan-sync-helper-v0.1` with `git branch -d`.
3. If normal removal refuses because untracked files remain, stop and report the exact paths; do not use forced removal without separate approval.
4. Report that automated verification passed, while retaining the existing release-blocked status for OpenClaw integration smoke and real Aliyun-account acceptance.
