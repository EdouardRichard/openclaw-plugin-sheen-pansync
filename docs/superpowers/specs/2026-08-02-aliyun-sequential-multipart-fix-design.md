# Aliyun Sequential Multipart Upload and Setup Localization Fix Design

## Problem

The real 41 MiB acceptance upload reached `pan_sync_upload` but failed with
`UPLOAD_FAILED`; no remote object was created. Small single-part uploads,
Unicode names, and duplicate-name auto-renaming all succeeded on the same
account and credential state.

The implementation currently sends `parallel_upload: true` and uploads up to
three parts concurrently without supplying the parallel SHA context required by
Aliyun PDS. Aliyun's ordinary multipart flow requires parts of one file to be
uploaded in sequence.

The one-time setup page currently exposes only English labels and raw stable
status/error codes. The release must default to Simplified Chinese and support
an in-page English switch without changing the API or Tool error-code contract.

## Approved Approach

Use sequential streaming multipart upload:

- Send `parallel_upload: false` when creating the upload.
- Upload returned part URLs strictly in ascending `part_number` order.
- Keep the existing positional, 64 KiB streaming reads so memory use remains
  bounded.
- Preserve the existing 20 MiB part size, 10,000-part ceiling, upload URL
  refresh behavior, caller cancellation, token refresh, rate-limit mapping,
  duplicate-name protection, and bounded public error codes.
- Do not retry the same part automatically and do not fall back from concurrent
  to sequential mode after a real request; this avoids duplicate external
  traffic and orphaned upload attempts.

## Components

- `src/providers/aliyun/upload.ts`: replace the concurrent worker pool with a
  single ordered loop and mark the create request as non-parallel.
- `tests/unit/aliyun-upload.test.ts`: encode the Aliyun sequential-order
  contract, prove the old concurrent implementation fails that contract, and
  retain coverage for streaming boundaries, cancellation, URL refresh, error
  mapping, zero-byte files, and the provider registry contract.
- `ui/setup.html`: add stable localization hooks and the language switch while
  keeping the existing form and security structure.
- `ui/setup.js`: add the fixed bilingual dictionary, rendering functions, and
  localized safe-code descriptions without changing request/response payloads.
- `ui/setup.css`: style the compact language switch using the existing visual
  system.
- `tests/integration/admin-server.test.ts`: verify Chinese defaults, complete
  English switching, unchanged raw error codes, localized descriptions,
  accessibility language state, credential-field preservation during switches,
  and existing anti-leakage behavior.

No public TypeScript interface changes.

## Setup Page Localization

Use one HTML document and a fixed in-page dictionary in `ui/setup.js`:

- Every page load starts in Simplified Chinese (`zh-CN`) regardless of browser
  locale.
- A visible `中文 / English` control switches all user-facing page copy without
  reload and updates the document `lang` and title.
- The selection is intentionally not persisted because the setup origin uses a
  one-time random loopback port and Chinese must remain the default for every
  new session.
- Translate the heading, risk warning, field labels, authorization link,
  buttons, notes, accessibility labels, working state, success states, and safe
  error descriptions.
- Preserve every raw status/error code. Error output is a localized description
  followed by the unchanged code, for example `上传失败（UPLOAD_FAILED）` and
  `Upload failed (UPLOAD_FAILED)`.
- Language switching only assigns trusted fixed strings with `textContent` or
  equivalent safe DOM properties. It never reads, clears, logs, submits, or
  copies any credential field.
- Do not add remote assets, inline scripts, or weaker CSP rules.

## Data Flow

1. Create the remote upload with an ordered `part_info_list` and
   `parallel_upload: false`.
2. Parse and sort the returned part URLs.
3. For each part in ascending order, refresh an expired signed URL if needed,
   stream only that file range with its exact `Content-Length`, and wait for a
   successful PUT before starting the next part.
4. Call `openFile/complete` only after every part succeeds.
5. On the first failure or caller cancellation, stop immediately and return the
   existing bounded `PanSyncError` code.

The setup page continues to receive the same bounded codes from the local API.
It selects the description for the current language and renders the unchanged
code beside it. Switching language rerenders fixed copy and the last bounded
status only; form values and request state remain untouched.

## Verification

- RED: a fake server rejects any part started before the preceding part ends;
  the current worker pool must fail this test.
- GREEN: the same test passes with ordered part events and maximum PUT
  concurrency of one.
- Run the focused Aliyun upload tests, all unit/integration tests, typecheck,
  build, package/leakage checks, and the full `npm run verify` gate.
- RED: the current page must fail assertions for `html[lang="zh-CN"]`, Chinese
  default copy, the English toggle, and localized descriptions that retain the
  exact code.
- GREEN: all static and dynamic setup-page states pass in both languages;
  switching with a canary token present preserves the exact input value and
  does not add it to page text, errors, or console output.
- Rebuild a new artifact, recompute SHA-256, reinstall that exact archive into
  the live OpenClaw instance, and restart the Gateway.
- Retry the 41 MiB real upload exactly once. Only after it succeeds continue the
  remaining partial-result, no-intent, restart-persistence, and leakage matrix.

## Out of Scope

- Parallel SHA-context generation.
- Automatic network retries or rate-limit testing.
- Deleting any remote acceptance file or incomplete upload state.
- Changing credential storage, authorization, Tool schema, or destination
  semantics.
- Translating CLI output, HTTP response bodies, Tool result fields, or raw error
  codes.
- Browser-language auto-detection or language persistence between setup
  sessions.

## Reference

Aliyun PDS upload guidance states that ordinary parts of a single file must be
uploaded in sequence and cannot be uploaded concurrently:
https://help.aliyun.com/en/pds/drive-and-photo-service-dev/user-guide/upload-file
