# Task 2 Report: Remote setup server binding and Host validation

## Changed files

- `src/admin/setup-server.ts`: binds the setup server to IPv4 wildcard address `0.0.0.0` through `bindFetchSafeServer`; preserves the canonical `127.0.0.1` UI/CLI URL; validates syntactically valid IPv4/hostname Hosts only when they specify the selected port.
- `tests/integration/admin-server.test.ts`: verifies wildcard binding, canonical loopback URL, accepted valid remote Hosts, and rejected absent/wrong-port/ambiguous/IPv6 Hosts. The security-header rejected-Host fixture now uses a wrong port.
- `.superpowers/sdd/2026-08-03-remote-configuration-readme/task-2-report.md`: this report.

## TDD evidence

Observable breaks named before the test change:

1. The setup listener still bound only to loopback.
2. A syntactically valid remote IPv4 address or hostname using the selected port was rejected.

RED command:

```powershell
npx vitest run tests/integration/admin-server.test.ts
```

RED result: 35 passed, 2 failed. The failures were exactly `expected '127.0.0.1' to be '0.0.0.0'` and `expected 400 to be 200` for a valid remote Host.

GREEN command:

```powershell
npx vitest run tests/integration/admin-server.test.ts
```

GREEN result: 37 passed.

Leakage regression:

```powershell
npx vitest run tests/integration/leakage.test.ts
```

Leakage result: 28 passed.

`git diff --check` also passed before the implementation commit.

## Self-review

- The setup lifetime remains `10 * 60 * 1_000` ms.
- The listener is IPv4-only (`0.0.0.0`), while `SetupServer.url` remains the canonical `http://127.0.0.1:<port>/#<key>` address.
- The Host parser rejects whitespace, credentials, request-target delimiters, absent/wrong ports, and bracketed IPv6 before accepting a URL-parsed hostname.
- Forwarding-header rejection, one-time authorization, credential handling, request cleanup, and security-header behavior remain covered by the focused suite.
- Mutation check: changing the bind host, accepting a wrong port, or omitting the ambiguous-input checks would fail the updated binding/Host tests.

## Commit

Implementation and test commit: `48e1b459af4384ee02f2a8976a10b8d625b74720` (`feat: allow remote setup server access`).

## Concerns

No known concerns within Task 2 scope. The requested checks validate local server behavior; real remote-network reachability depends on the host firewall and deployment network, which are outside this task.
