# Resource-drive read release verification

Verification date: 2026-08-03

Automated gate: PASS
OpenClaw integration gate: FAIL
Real Aliyun resource-drive gate: NOT RUN
Chinese README journey: NOT RUN
English README journey: NOT RUN
Screenshot sanitization gate: PASS
Package inspection gate: PASS
Release decision: BLOCKED

## Versions and artifact

- Node.js current gate: `24.18.1`
- Node.js lower-bound gate: `22.23.1` via Volta
- npm: `11.18.0`
- TypeScript: `5.9.3`
- Vitest: `3.2.7`
- OpenClaw: `2026.7.1-2`
- Package: `openclaw-pan-sync-helper@0.1.0`
- Exact packed artifact SHA-256: `9a706590407deb4f73b3c09e398eaf67090cd50c227e83447ce8bfa188a3bc49`

## Automated gate

Two fresh full verification runs were used as the release gate: `npm run verify` on Node `24.18.1`, then `volta run --node 22.23.1 npm run verify` at the supported Node 22 lower bound. Each run completed TypeScript type checking, unit tests, integration tests, a production build, and `npm pack --dry-run`.

Fresh counts per run:

- Unit: 19 files passed; 327 tests passed; 1 test skipped.
- Integration: 10 files passed; 113 tests passed.
- TypeScript typecheck: PASS.
- Build: PASS.
- Package dry run: PASS.

The integration count includes 28 leakage-contract tests. Automated checks are evidence for the packaged behavior, not a replacement for the incomplete real-account acceptance rows below.

## Exact package inspection

One uniquely packed tarball was retained through installed-artifact testing and identified by the SHA-256 above. Its 106 entries were inspected directly.

Present:

- `dist/tool.js` and `dist/read/tool.js`;
- exactly one published Skill at `skills/pan-sync-upload/SKILL.md`;
- the bilingual `README.md`;
- the OpenList token guide;
- exactly the four approved README PNG files.

Absent:

- tests and TypeScript source;
- dependency trees and task workspaces;
- runtime state, private keys, and credential data;
- unapproved or extra README screenshots.

## Installed OpenClaw smoke test

The exact tarball was installed into a fresh isolated OpenClaw state. Runtime inspection reported the plugin loaded, enabled, and activated with no error diagnostics. It exposed exactly `pan_sync_upload`, `pan_sync_list`, and `pan_sync_download`. The installed CLI recognized `pan-sync configure`.

After setting `gateway.mode=local` only inside that otherwise fresh temporary state, the installed runtime reported one registered plugin HTTP route. However, a foreground token-authenticated local Gateway returned HTTP 404 for the exact status route both without authentication and with the supported Bearer authentication. Neither response contained plugin or status-page content. This proves no unauthenticated status disclosure in that probe, but the authenticated status route was not reachable. The OpenClaw integration gate is therefore FAIL; no plugin or Gateway code was changed during verification.

## Real Aliyun observations and missing rows

The existing configured test profile was used only for bounded benign operations. Before testing, the two read Tools were merged temporarily into the effective policy while preserving the existing grant, then the Gateway was safely restarted. After the bounded matrix stopped, the exact original policy was restored, both temporary grants were absent, and the Gateway was safely restarted and found reachable.

Fresh partial observations:

- A Chinese request created the benign demo file and invoked `pan_sync_upload`; the turn completed with no Tool failure.
- A fresh read session made six successful `pan_sync_list` calls covering the resource-drive root plus English and Chinese name searches. A short follow-up summarized that the root list succeeded and both safe demo names were found; the visible result contained no forbidden credential or identifier pattern.
- A bounded `limit: 1` search returned a cursor and continued it exactly once. Both `pan_sync_list` calls completed with no Tool failure.
- Sanitized visible responses from these turns contained no token, URL, drive ID, file ID, or local absolute-path pattern.

The following required matrix rows were not run in this verification pass:

- a fresh download with source/download SHA-256 comparison;
- a second fresh download proving collision naming without changing the first file;
- the over-100-MiB pre-confirmation/no-local-file check and one approved retry;
- direct inspection proving the new acceptance files are absent from the backup drive;
- a complete sanitized log inspection across the whole matrix.

No large-file transfer was started. Resource-drive-only implementation and automated tests do not substitute for direct backup-drive exclusion evidence. Because the real matrix is incomplete, its gate is NOT RUN rather than PASS.

## README journeys and screenshots

The Chinese and English quick-start journeys were not rerun end-to-end in separate fresh configured states. The plugin deliberately requires a manually supplied Aliyun refresh token, and no credential was copied into isolated verification states. Both README journey gates are therefore NOT RUN.

The four packaged screenshots were inspected at original resolution and also passed PNG signature, dimensions, size, and exact-allowlist tests. They show the real installed-plugin, upload, search, and download/read flow with benign demo names. No token, URL, dynamic port, file ID, drive ID, host name, local absolute path, raw Shell output, or service log is visible. This screenshot evidence is not a substitute for the incomplete full matrix or fresh bilingual README journeys.

## Decision

The automated, screenshot-sanitization, and package-inspection gates pass. Release remains BLOCKED because the OpenClaw authenticated status route smoke test fails and the real Aliyun and both README journey gates are not complete.
