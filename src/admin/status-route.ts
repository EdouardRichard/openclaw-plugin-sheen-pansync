import type { ServerResponse } from "node:http";
import type { OpenClawPluginHttpRouteHandler } from "openclaw/plugin-sdk/plugin-entry";
import type { PluginConfig } from "../config.js";
import type { CredentialStore } from "../credentials/store.js";
import type {
  TokenManager,
  TokenManagerStatus,
} from "../credentials/token-manager.js";
import type { CredentialRecord } from "../credentials/types.js";

export const STATUS_SECURITY_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
} as const;

export type PanSyncStatusRouteDependencies = {
  store: Pick<CredentialStore, "read">;
  tokenManager: Pick<TokenManager, "statusForSnapshot">;
  config: Pick<PluginConfig, "defaultDirectory">;
};

const BOUNDED_STATUSES: ReadonlySet<string> = new Set([
  "unconfigured",
  "ready",
  "degraded",
  "rate_limited",
  "reauth_required",
]);

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function trustedMaskedSummary(value: string | undefined): string {
  return value !== undefined && value.includes("*") ? value : "unavailable";
}

function boundedStatus(value: unknown): TokenManagerStatus {
  return typeof value === "string" && BOUNDED_STATUSES.has(value)
    ? value as TokenManagerStatus
    : "degraded";
}

function renderStatusPage(
  status: TokenManagerStatus,
  record: CredentialRecord | undefined,
  defaultDirectory: string,
): string {
  const configured = record !== undefined;
  const account = configured
    ? trustedMaskedSummary(
      record.account.displayNameMasked ?? record.account.userIdMasked,
    )
    : "unavailable";
  const lastVerifiedAt = configured ? record.lastVerifiedAt : "unavailable";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Sheen PanSync</title>
  <style>
    :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
    body { margin: 0; padding: 2rem; background: Canvas; color: CanvasText; }
    main { max-width: 46rem; margin: 0 auto; }
    dl { display: grid; grid-template-columns: max-content 1fr; gap: .75rem 1.25rem; }
    dt { font-weight: 650; }
    dd { margin: 0; overflow-wrap: anywhere; }
    code { padding: .2rem .4rem; border: 1px solid GrayText; border-radius: .3rem; }
  </style>
</head>
<body>
  <main>
    <h1>Sheen PanSync</h1>
    <p>Read-only connection status. Credential changes are available only from the local configuration command.</p>
    <dl>
      <dt>Provider</dt><dd>aliyun</dd>
      <dt>Status</dt><dd>${escapeHtml(status)}</dd>
      <dt>Configured</dt><dd>${configured ? "yes" : "no"}</dd>
      <dt>Token service</dt><dd>OpenList</dd>
      <dt>Account</dt><dd>${escapeHtml(account)}</dd>
      <dt>Default directory</dt><dd>${escapeHtml(defaultDirectory)}</dd>
      <dt>Last verified</dt><dd>${escapeHtml(lastVerifiedAt)}</dd>
    </dl>
    <h2>Configuration</h2>
    <p>Run <code>openclaw pan-sync configure</code> on the OpenClaw host.</p>
  </main>
</body>
</html>
`;
}

function setSecurityHeaders(response: ServerResponse): void {
  for (const [name, value] of Object.entries(STATUS_SECURITY_HEADERS)) {
    response.setHeader(name, value);
  }
}

export function createPanSyncStatusRoute(
  dependencies: PanSyncStatusRouteDependencies,
): OpenClawPluginHttpRouteHandler {
  return async (request, response) => {
    setSecurityHeaders(response);
    const method = request.method ?? "";
    if (method !== "GET" && method !== "HEAD") {
      response.statusCode = 405;
      response.setHeader("Allow", "GET, HEAD");
      response.end();
      return true;
    }

    let record: CredentialRecord | undefined;
    let status: TokenManagerStatus;
    try {
      record = await dependencies.store.read();
      status = boundedStatus(
        dependencies.tokenManager.statusForSnapshot(record),
      );
    } catch {
      record = undefined;
      status = "degraded";
    }
    const body = renderStatusPage(
      status,
      record,
      dependencies.config.defaultDirectory,
    );
    response.statusCode = 200;
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.setHeader("Content-Length", Buffer.byteLength(body));
    response.end(method === "HEAD" ? undefined : body);
    return true;
  };
}
