# Pan Sync Helper Full-Flow Release Acceptance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove that one exact Pan Sync Helper package is safe, installable, and fully usable through the running OpenClaw instance and a real Aliyun Drive account, fixing every reproducible product defect with root-cause-led TDD before final delivery.

**Architecture:** Verification advances through repository, isolated installed-package, active OpenClaw, and real-account gates. A single hashed `.tgz` crosses every runtime gate; deterministic local fakes cover destructive external failure modes, while the real account covers authorization and upload success paths. Any reproducible failure stops progression and receives its own exact defect amendment before production code changes.

**Tech Stack:** Windows PowerShell, Git worktrees, Node.js 22.23.1 via Volta, TypeScript ESM, Vitest 3.2, OpenClaw 2026.7.1-2, loopback HTTP fixtures, OpenList, Aliyun Drive.

## Global Constraints

- Source design: `docs/superpowers/specs/2026-08-02-full-flow-release-acceptance-design.md`.
- Work in an isolated `.worktrees/full-flow-acceptance` checkout on branch `codex/full-flow-acceptance`.
- Preserve the main checkout's untracked `dist/` and `node_modules/`; never stage them.
- Do not commit, push, publish, or create a pull request.
- Build one `.tgz`, record its SHA-256, and use that exact artifact for all installed-package and real-instance gates.
- Never record Refresh Tokens, Access Tokens, one-time URL fragments, dynamic ports, complete configured URLs, account identifiers, raw sensitive logs, or private absolute paths in repository documents.
- Never send deliberate rate-limit traffic to OpenList or Aliyun. Simulate `429`, network failure, timeout, `5xx`, and refresh-token rejection only with dummy credentials and loopback fakes.
- Do not revoke or deliberately invalidate the user's real authorization.
- Remote test files use a unique run prefix under `/openClawShare`; do not overwrite or delete pre-existing remote files.
- Only the user performs QR login, Refresh Token paste, Dashboard login, CAPTCHA, risk-control, and device-confirmation actions.
- Every production-code change requires a failing regression test first, an observed correct RED result, a minimal fix, focused GREEN, and a fresh complete gate.

---

### Task 1: Create the isolated execution workspace and prove the repository baseline

**Files:**

- Read: `.gitignore`
- Read: `package.json`
- Preserve: `D:\Project_new\openClaw-panSyncHelper\dist\`
- Preserve: `D:\Project_new\openClaw-panSyncHelper\node_modules\`
- Create outside tracked files: `.worktrees/full-flow-acceptance/`

**Interfaces:**

- Consumes: approved design and clean tracked `main` at commit `855a0374ca64ec49ccd100df690d1773c27d9c5b`.
- Produces: isolated checkout path, baseline Git status, dependency installation, and full verification result.

- [ ] **Step 1: Recheck isolation and user-owned state**

Run from the main checkout:

```powershell
git rev-parse --show-toplevel
git rev-parse --path-format=absolute --git-dir
git rev-parse --path-format=absolute --git-common-dir
git branch --show-current
git status --short --branch
git check-ignore -v .worktrees
git worktree list --porcelain
```

Expected: normal `main` checkout; `.worktrees/` is ignored; only the approved design/plan plus existing `dist/` and `node_modules/` are untracked.

- [ ] **Step 2: Create the worktree without touching main checkout artifacts**

Run:

```powershell
git worktree add .worktrees/full-flow-acceptance -b codex/full-flow-acceptance 855a0374ca64ec49ccd100df690d1773c27d9c5b
git -C .worktrees/full-flow-acceptance status --short --branch
```

Expected: branch `codex/full-flow-acceptance`, clean tracked state, and no nested copy of the main checkout's untracked `dist/` or `node_modules/`.

- [ ] **Step 3: Install exact locked dependencies in the worktree**

Run:

```powershell
volta run --node 22.23.1 npm ci --no-audit --no-fund
```

Working directory: `.worktrees/full-flow-acceptance`.

Expected: exit `0`; `package-lock.json` remains unchanged.

- [ ] **Step 4: Run the fresh complete baseline gate**

Run:

```powershell
volta run --node 22.23.1 npm run verify
git diff --check
git status --short --branch
```

Expected: typecheck, all unit tests, all integration tests, build, and package dry-run exit `0`; only generated ignored/untracked content is present. Any stable failure routes to Task 8 before Task 2 begins.

---

### Task 2: Build and fingerprint the single release candidate

**Files:**

- Read: `package.json`
- Read: `openclaw.plugin.json`
- Read: `tests/integration/package.test.ts`
- Create outside Git tracking: `.acceptance-artifacts/<run-id>/openclaw-pan-sync-helper-0.1.0.tgz`
- Create at final reporting time: `docs/verification/2026-08-02-full-flow-release-acceptance.md`

**Interfaces:**

- Consumes: Task 1 passing worktree.
- Produces: `$acceptanceRunId`, `$acceptanceArtifact`, SHA-256, byte size, and package file count used by Tasks 3-7.

- [ ] **Step 1: Create a unique local artifact directory**

Run in the worktree:

```powershell
$acceptanceRunId = Get-Date -Format 'yyyyMMdd-HHmmss'
$acceptanceArtifactDir = Join-Path (Get-Location) ".acceptance-artifacts\$acceptanceRunId"
New-Item -ItemType Directory -Path $acceptanceArtifactDir | Out-Null
```

Expected: the directory is inside the ignored worktree and contains no prior artifact.

- [ ] **Step 2: Build and pack once**

Run:

```powershell
volta run --node 22.23.1 npm run build
volta run --node 22.23.1 npm pack --json --pack-destination $acceptanceArtifactDir
```

Expected: one `openclaw-pan-sync-helper-0.1.0.tgz` is created and the JSON report lists the packed files.

- [ ] **Step 3: Record provenance without secrets**

Run:

```powershell
$acceptanceArtifact = (Get-ChildItem -LiteralPath $acceptanceArtifactDir -Filter '*.tgz' -File | Select-Object -Single -ExpandProperty FullName)
$acceptanceHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $acceptanceArtifact).Hash.ToLowerInvariant()
$acceptanceSize = (Get-Item -LiteralPath $acceptanceArtifact).Length
$acceptanceEntries = @(tar -tf $acceptanceArtifact)
[pscustomobject]@{ RunId=$acceptanceRunId; Sha256=$acceptanceHash; Bytes=$acceptanceSize; Entries=$acceptanceEntries.Count } | Format-List
```

Expected: exactly one artifact, a 64-character SHA-256, positive byte size, and positive entry count. Record only these sanitized values in Task 9.

- [ ] **Step 4: Enforce package boundaries**

Run:

```powershell
$acceptanceEntries | Select-String -Pattern '(^|/)(src|tests|node_modules|plugin-data|\.superpowers)(/|$)|(^|/)(\.env|master\.key|credentials\.enc)$'
volta run --node 22.23.1 npm exec -- vitest run tests/integration/package.test.ts tests/integration/leakage.test.ts --reporter=verbose
```

Expected: package-boundary search returns no matches and both focused integration files pass.

---

### Task 3: Verify the package in an isolated OpenClaw state

**Files:**

- Test: `tests/integration/package.test.ts`
- Test: `tests/integration/plugin-entry.test.ts`
- Test: `tests/integration/admin-cli.test.ts`
- Test: `tests/integration/admin-server.test.ts`
- Test: `tests/unit/openlist-token-service.test.ts`
- Test: `tests/unit/token-manager.test.ts`
- Test: `tests/unit/orchestrator.test.ts`
- Create outside Git tracking: a temporary isolated `OPENCLAW_STATE_DIR`

**Interfaces:**

- Consumes: exact `$acceptanceArtifact` and `$acceptanceHash` from Task 2.
- Produces: installed runtime registration evidence and deterministic failure-mode evidence without external service traffic.

- [ ] **Step 1: Run the deterministic failure-state matrix**

Run:

```powershell
volta run --node 22.23.1 npm exec -- vitest run tests/unit/openlist-token-service.test.ts tests/unit/token-manager.test.ts tests/unit/orchestrator.test.ts --reporter=verbose
```

Expected: loopback/dummy tests for `429`, timeout, network/`5xx`, rejection, token rotation, concurrent refresh, cooldown persistence, and upload preconditions all pass. No real OpenList or Aliyun endpoint is used by these tests.

- [ ] **Step 2: Run installed-package and UI integration contracts**

Run:

```powershell
volta run --node 22.23.1 npm exec -- vitest run tests/integration/package.test.ts tests/integration/plugin-entry.test.ts tests/integration/admin-cli.test.ts tests/integration/admin-server.test.ts --reporter=verbose
```

Expected: official package installation, runtime registration, loopback binding, one-time setup authorization, save/clear/reload/pagehide/timeout behavior, security headers, status route, CLI registration, and Skill contract all pass.

- [ ] **Step 3: Install the exact artifact into a fresh isolated state**

Run:

```powershell
$isolatedStateRoot = Join-Path ([System.IO.Path]::GetTempPath()) "pan-sync-acceptance-$acceptanceRunId"
New-Item -ItemType Directory -Path $isolatedStateRoot | Out-Null
$env:OPENCLAW_STATE_DIR = $isolatedStateRoot
Remove-Item Env:OPENCLAW_CONFIG_PATH -ErrorAction SilentlyContinue
openclaw plugins install $acceptanceArtifact
openclaw plugins enable pan-sync-helper
openclaw plugins inspect pan-sync-helper --runtime --json
openclaw plugins doctor
openclaw skills info pan-sync-upload --json
```

Expected: plugin is loaded, enabled, and activated; diagnostics are empty; `pan_sync_upload`, `pan-sync`, one HTTP route, one service, one Control UI descriptor, and eligible `pan-sync-upload` Skill are present.

- [ ] **Step 4: Prove the installed CLI reaches readiness and only binds loopback**

Start `openclaw --no-color pan-sync configure` with the isolated environment, capture the one-time URL only in process memory, and inspect the corresponding listener with `Get-NetTCPConnection`.

Expected: CLI prints readiness, exactly one listener exists on `127.0.0.1`, and no `0.0.0.0`, `::`, or non-loopback listener exists. Stop the exact CLI process and confirm its listener count returns to zero.

- [ ] **Step 5: Remove only the isolated state after validating its exact path**

Run:

```powershell
$resolvedIsolatedState = [System.IO.Path]::GetFullPath($isolatedStateRoot)
$resolvedTempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
if (-not $resolvedIsolatedState.StartsWith($resolvedTempRoot, [StringComparison]::OrdinalIgnoreCase) -or -not (Split-Path $resolvedIsolatedState -Leaf).StartsWith('pan-sync-acceptance-')) { throw 'refusing unexpected isolated state cleanup' }
Remove-Item -LiteralPath $resolvedIsolatedState -Recurse -Force
Remove-Item Env:OPENCLAW_STATE_DIR -ErrorAction SilentlyContinue
```

Expected: only the exact temporary isolated state is removed; the real `C:\Users\Richard\.openclaw` state is untouched.

---

### Task 4: Install the release candidate into the running OpenClaw instance

**Files:**

- Read/backup outside Git: `C:\Users\Richard\.openclaw\openclaw.json`
- Read/backup outside Git when present: plugin installation metadata under `C:\Users\Richard\.openclaw\npm\`
- Read/backup outside Git when present: `C:\Users\Richard\.openclaw\state\pan-sync-helper\`
- Install: exact `$acceptanceArtifact`

**Interfaces:**

- Consumes: Task 3 passing artifact and current healthy loopback gateway.
- Produces: active-instance plugin registration and safe unconfigured behavior.

- [ ] **Step 1: Capture a sanitized pre-install snapshot**

Run:

```powershell
openclaw --version
openclaw gateway status
openclaw plugins inspect pan-sync-helper --runtime --json
openclaw skills info pan-sync-upload --json
```

Expected baseline: gateway connectivity is healthy; the plugin and Skill are absent. Do not copy raw logs into repository documents.

- [ ] **Step 2: Create a local recovery backup**

Create a new directory under the current user's temporary directory named `pan-sync-live-backup-$acceptanceRunId`. Copy `openclaw.json` and only existing Pan Sync Helper installation/state entries into it. Record the backup directory only in process memory, not in the repository report.

Expected: original files remain unchanged and backup copies exist before installation.

- [ ] **Step 3: Install and enable the exact artifact**

Run with the real OpenClaw state environment restored:

```powershell
openclaw plugins install $acceptanceArtifact
openclaw plugins enable pan-sync-helper
openclaw plugins inspect pan-sync-helper --runtime --json
openclaw plugins doctor
openclaw skills info pan-sync-upload --json
```

Expected: the same registration contract as Task 3 is visible in the current instance and diagnostics remain empty.

- [ ] **Step 4: Restart and re-probe the Gateway**

Run:

```powershell
openclaw gateway restart
openclaw gateway status
openclaw gateway health
openclaw plugins inspect pan-sync-helper --runtime --json
```

Expected: gateway returns to `running`, listens only on `127.0.0.1`, connectivity is `ok`, versions match, and plugin registration survives restart.

- [ ] **Step 5: Verify the unconfigured contract before real authorization**

Run `openclaw pan-sync configure`, open the loopback page without entering a real Token, and verify the status page/Tool behavior reports only `unconfigured` or `CREDENTIALS_REQUIRED` with safe configuration guidance.

Expected: no credential record is created, no external token endpoint is called, and no sensitive value appears in status or Tool output.

---

### Task 5: Complete user-assisted real OpenList authorization

**Files:**

- Runtime state only: `C:\Users\Richard\.openclaw\state\pan-sync-helper\`
- No repository file contains authorization material.

**Interfaces:**

- Consumes: Task 4 installed and unconfigured live instance.
- Produces: real `ready` state validated through safe projections.

- [ ] **Step 1: Launch the one-time configuration page**

Run `openclaw --no-color pan-sync configure` and retain the full loopback URL only long enough to open it in the user's browser. Confirm the listener is loopback-only before asking the user to proceed.

- [ ] **Step 2: Ask the user to perform the authorization step**

Ask the user to select Aliyun Drive App Login on the default mainland-China OpenList page, scan the QR code, copy the returned Refresh Token, paste it into the local page, and save. The assistant must not request the Token in chat or inspect clipboard/history.

- [ ] **Step 3: Verify successful save through bounded outputs**

Expected: local page shows `READY`; the configuration server closes; normal status shows `ready`, a masked account summary or `unavailable`, the default directory, and a bounded last-verified timestamp. It must not show Token values or complete configured URLs.

- [ ] **Step 4: Verify credential-at-rest boundaries**

Check only file names, sizes, ACL/mode behavior applicable to Windows, and absence of plaintext Token fragments in ordinary config/log/status outputs. Do not print encrypted record contents, keys, or raw application logs.

---

### Task 6: Run the real Aliyun upload and intent-routing matrix

**Files:**

- Create in OpenClaw workspace: `pan-sync-acceptance-<run-id>/small-en.txt`
- Create in OpenClaw workspace: `pan-sync-acceptance-<run-id>/验收-small-cn.txt`
- Create in OpenClaw workspace: `pan-sync-acceptance-<run-id>/multipart-41m.bin`
- Reference as missing: `pan-sync-acceptance-<run-id>/missing.txt`
- Remote destination: `/openClawShare`

**Interfaces:**

- Consumes: Task 5 `ready` credentials, exact active plugin artifact, and active OpenClaw gateway.
- Produces: real upload outcomes and actual agent intent-routing evidence.

- [ ] **Step 1: Create bounded, non-sensitive local fixtures**

Use `apply_patch` to create the two small UTF-8 text files with run-id-only content. Generate `multipart-41m.bin` as a deterministic 41 MiB zero-filled fixture, then verify all three files resolve inside `C:\Users\Richard\.openclaw\workspace\pan-sync-acceptance-<run-id>` and record only their relative names and byte sizes.

- [ ] **Step 2: Verify explicit English upload intent**

Use a dedicated OpenClaw acceptance session and send an explicit request to upload `small-en.txt` to Aliyun Drive. Capture sanitized JSON result metadata.

Expected: `pan_sync_upload` is invoked once, the file succeeds, and the remote destination is `/openClawShare`.

- [ ] **Step 3: Verify explicit Chinese upload intent and Unicode file handling**

In the same acceptance session, explicitly request upload of `验收-small-cn.txt` to 阿里云盘.

Expected: `pan_sync_upload` is invoked once and the Unicode-named file succeeds.

- [ ] **Step 4: Verify duplicate-name protection**

Request a second upload of `small-en.txt`.

Expected: the pre-existing remote name is not overwritten; the returned successful item reports a distinct resolved remote name.

- [ ] **Step 5: Verify multipart upload**

Explicitly request upload of `multipart-41m.bin`.

Expected: the file larger than 40 MiB completes through multipart upload and its reported byte size matches the local fixture.

- [ ] **Step 6: Verify partial multi-file results**

Explicitly request one call containing `small-en.txt` and the nonexistent `missing.txt`.

Expected: the existing item succeeds or is safely renamed, the nonexistent item fails with a bounded path error, the result is partial rather than all-or-nothing, and no successfully handled normalized path is uploaded twice within the request.

- [ ] **Step 7: Verify discussion does not trigger upload**

Ask a question that only discusses what kinds of files people usually keep in cloud drives and contains no upload/sync/push verb.

Expected: no `pan_sync_upload` Tool call occurs and no remote file is created.

---

### Task 7: Prove restart recovery and leakage resistance on the live instance

**Files:**

- Read only: current OpenClaw gateway status, bounded diagnostics, and sanitized agent results.
- Create in OpenClaw workspace: one additional small restart probe file under the same run directory.

**Interfaces:**

- Consumes: completed real uploads from Task 6.
- Produces: post-restart upload success, credential persistence evidence, and leakage scan result.

- [ ] **Step 1: Restart the active Gateway after successful authorization**

Run:

```powershell
openclaw gateway restart
openclaw gateway status
openclaw gateway health
openclaw plugins inspect pan-sync-helper --runtime --json
```

Expected: gateway and plugin return healthy without re-entering credentials.

- [ ] **Step 2: Verify persisted `ready` status and another upload**

Create one small restart probe file, request its upload through the dedicated acceptance session, and confirm one successful Tool call.

Expected: status remains `ready` and upload succeeds after restart.

- [ ] **Step 3: Run bounded leakage checks**

Run the repository leakage suite again. Inspect only sanitized status output, agent result envelopes, and log metadata for forbidden key names or test canaries; never copy raw credential-bearing logs into the report.

Expected: no Refresh Token, Access Token, one-time key, complete configured URL, or private absolute source path is exposed.

- [ ] **Step 4: Confirm remote test scope**

Record the number, sanitized relative names, and sizes of files created by this run. Do not delete them and do not inspect unrelated remote content.

---

### Task 8: Apply the root-cause and TDD defect loop whenever a gate fails

**Files:**

- Registration/package defects: `tests/integration/package.test.ts`, `tests/integration/plugin-entry.test.ts`, `src/index.ts`, `cli-metadata.js`, `openclaw.plugin.json`, `package.json`
- CLI/setup defects: `tests/integration/admin-cli.test.ts`, `tests/integration/admin-server.test.ts`, `src/admin/cli.ts`, `src/admin/setup-server.ts`, `src/admin/setup-page.ts`, `ui/setup.html`, `ui/setup.js`, `ui/setup.css`
- Token/status defects: `tests/unit/openlist-token-service.test.ts`, `tests/unit/token-manager.test.ts`, `tests/integration/admin-server.test.ts`, `src/providers/aliyun/openlist-token-service.ts`, `src/credentials/token-manager.ts`, `src/admin/status-route.ts`
- Upload defects: `tests/unit/aliyun-upload.test.ts`, `tests/unit/aliyun-provider.test.ts`, `tests/unit/orchestrator.test.ts`, `tests/integration/tool.test.ts`, `src/providers/aliyun/upload.ts`, `src/providers/aliyun/provider.ts`, `src/upload/orchestrator.ts`, `src/tool.ts`
- Intent defects: `tests/integration/plugin-entry.test.ts`, `skills/pan-sync-upload/SKILL.md`
- Add for each confirmed defect: `docs/superpowers/plans/2026-08-02-<specific-defect>.md`

**Interfaces:**

- Consumes: one stable failing gate with exact reproduction and sanitized evidence.
- Produces: a defect-specific amendment, correct RED/GREEN evidence, minimal production fix, and rerun of every affected downstream gate.

- [ ] **Step 1: Stop progression and reproduce the same failure twice**

Record the exact command, exit code, bounded error code, affected layer, and whether the failure is deterministic. Check the current worktree diff and the five most recent commits before changing files.

- [ ] **Step 2: Trace the failing value or registration across component boundaries**

Identify where the correct value enters, where it first differs, and which component owns that transition. Compare the broken path with the closest complete working pattern in the same repository.

- [ ] **Step 3: State and minimally test one root-cause hypothesis**

Use a read-only probe or the smallest disposable instrumentation change. Change one variable only. If the hypothesis fails, remove the disposable probe and return to evidence gathering.

- [ ] **Step 4: Write a defect-specific plan before production edits**

Create `docs/superpowers/plans/2026-08-02-<specific-defect>.md` containing the exact failing test body, exact expected RED message, exact minimal production edit, and exact focused/full verification commands. Do not use generic repair language.

- [ ] **Step 5: Execute strict RED/GREEN**

Add the single regression test, run it until it fails for the intended missing behavior, implement only the root-cause fix, rerun the focused test to GREEN, and run all tests in the affected subsystem.

- [ ] **Step 6: Rebuild a new release candidate and invalidate the old artifact**

After any production/test/package change, return to Task 1 Step 4, then create a new run-id artifact through Task 2. All later gates must use only the new hash; never mix evidence from the superseded artifact.

- [ ] **Step 7: Escalate after three failed fix attempts**

If three distinct root-cause fixes fail for the same symptom, stop implementation and present the architectural conflict to the user before attempting another change.

---

### Task 9: Run the final gate and write the sanitized verification record

**Files:**

- Create: `docs/verification/2026-08-02-full-flow-release-acceptance.md`
- Read: `docs/superpowers/specs/2026-08-02-full-flow-release-acceptance-design.md`
- Read: `docs/superpowers/plans/2026-08-02-full-flow-release-acceptance.md`

**Interfaces:**

- Consumes: final artifact hash and results from every applicable matrix row.
- Produces: evidence-backed release verdict without credentials or private dynamic values.

- [ ] **Step 1: Re-run the complete repository gate against final source**

Run in the worktree:

```powershell
volta run --node 22.23.1 npm run verify
git diff --check
git status --short --branch
```

Expected: fresh exit `0`, zero test failures, successful build/package dry-run, and only intentional worktree changes.

- [ ] **Step 2: Recheck final artifact identity and live installation**

Recompute SHA-256 and size for the final artifact; verify the live installed plugin source corresponds to that artifact installation and repeat plugin inspect, doctor, Skill info, gateway status, and one post-restart small upload.

Expected: hashes and registrations are internally consistent; the final live smoke uses the same release candidate.

- [ ] **Step 3: Write the verification record**

The record must contain these bounded sections: reviewed commit/worktree; Node/OpenClaw/plugin versions; artifact SHA-256/size/file count; automated test counts and skips; isolated installation results; live registration results; real-account upload matrix; restart recovery; leakage result; remote-test-file count and sizes; failures fixed with their RED/GREEN commands; remaining `NOT RUN` or non-applicable rows; final verdict.

- [ ] **Step 4: Self-review the record against the approved design**

Search the record for placeholders and forbidden sensitive categories. Recheck every design requirement has a recorded PASS, justified non-applicable status, or explicit blocker. Any applicable `FAIL` or `NOT RUN` forces a blocked verdict.

- [ ] **Step 5: Preserve user-owned state and hand off without Git publication**

Leave the active gateway healthy and the plugin enabled. Keep the local recovery backup until the user accepts the result. Do not commit, stage, push, publish, delete the worktree, or delete remote test files.

