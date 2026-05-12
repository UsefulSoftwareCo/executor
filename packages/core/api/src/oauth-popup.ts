// ---------------------------------------------------------------------------
// OAuth popup HTTP helpers — server-side.
//
// `popupDocument` renders the HTML page returned by the OAuth redirect
// handler. The page immediately `postMessage`s the result back to the
// opener window and falls back to a `BroadcastChannel` if the opener is
// gone (mobile Safari closes the opener on popup open in some cases).
//
// `runOAuthCallback` wraps the "call completeOAuth, turn Exit into
// popup payload, render HTML" glue so plugin handlers stay one-liners.
// ---------------------------------------------------------------------------

import { Cause, Effect } from "effect";

import { OAUTH_POPUP_MESSAGE_TYPE, type OAuthPopupResult } from "@executor-js/sdk";

export { OAUTH_POPUP_MESSAGE_TYPE, isOAuthPopupResult } from "@executor-js/sdk";
export type { OAuthPopupResult } from "@executor-js/sdk";

// ---------------------------------------------------------------------------
// Completion listener — optional process-wide hook called every time an
// OAuth flow finishes (success or failure). Lets hosts that can't use the
// in-browser postMessage/BroadcastChannel handoff observe results another
// way (e.g. the local server registers an in-memory registry so the
// Electron renderer can poll over HTTP when the user signed in via the
// system browser).
//
// Default: no listener. Cloud hosts (Cloudflare Workers — stateless,
// multi-isolate) intentionally don't register one; an in-memory side
// channel can't bridge isolates and the same-origin web SPA already
// receives results via postMessage, so the listener is a no-op there.
// ---------------------------------------------------------------------------

export type OAuthCompletionListener = (result: OAuthPopupResult<unknown>) => void;

// TODO: replace with plugin notify framework
let completionListener: OAuthCompletionListener | null = null;

export const setOAuthCompletionListener = (listener: OAuthCompletionListener | null): void => {
  completionListener = listener;
};

// ---------------------------------------------------------------------------
// HTML generation
// ---------------------------------------------------------------------------

const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

/**
 * Serialize for embedding inside a `<script>` tag. Escapes the characters
 * that could prematurely terminate the script or mislead an HTML parser
 * (`<`, `>`, `&`) so an attacker-controlled `error` field can't break out.
 */
const serializeForScript = (value: unknown): string =>
  JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026");

/**
 * Render the HTML page that the OAuth redirect returns. The page is
 * intentionally dependency-free: inline CSS, dark-mode support via
 * `prefers-color-scheme`, and a small inline script that posts the result
 * back to the opener via `postMessage` + `BroadcastChannel` then closes
 * itself.
 */
export const popupDocument = <TAuth>(
  payload: OAuthPopupResult<TAuth>,
  channelName: string,
): string => {
  const serialized = serializeForScript(payload);
  const title = payload.ok ? "Connected" : "Connection failed";
  const message = payload.ok
    ? "Authentication complete. This window will close automatically."
    : payload.error;
  const details =
    !payload.ok && payload.errorDetails && payload.errorDetails !== payload.error
      ? payload.errorDetails
      : undefined;
  const statusColor = payload.ok ? "#22c55e" : "#ef4444";
  const icon = payload.ok
    ? '<path d="M6 10l3 3 5-6" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>'
    : '<path d="M7 7l6 6M13 7l-6 6" stroke="white" stroke-width="2" stroke-linecap="round"/>';
  const escapedChannel = escapeHtml(channelName);
  const detailsHtml = details
    ? `<details style="margin-top:16px;text-align:left"><summary style="cursor:pointer;font-size:12px;color:#888;user-select:none">Details</summary><pre style="white-space:pre-wrap;word-break:break-word;font-size:11px;line-height:1.5;color:#52525b;background:#f4f4f5;padding:8px;border-radius:4px;margin:8px 0 0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace">${escapeHtml(details)}</pre></details>`
    : "";

  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>${escapeHtml(title)}</title></head>
<body style="font-family:system-ui,-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#fafafa;color:#111">
<style>@media(prefers-color-scheme:dark){body{background:#09090b!important;color:#fafafa!important}p{color:#a1a1aa!important}pre{background:#18181b!important;color:#a1a1aa!important}}</style>
<main style="text-align:center;max-width:420px;padding:24px">
<div style="width:40px;height:40px;border-radius:50%;background:${statusColor};margin:0 auto 16px;display:flex;align-items:center;justify-content:center">
<svg width="20" height="20" viewBox="0 0 20 20" fill="none">${icon}</svg>
</div>
<h1 style="margin:0 0 8px;font-size:18px;font-weight:600">${escapeHtml(title)}</h1>
<p style="margin:0;font-size:14px;color:#666;line-height:1.5">${escapeHtml(message)}</p>
${detailsHtml}
</main>
<script>
(()=>{const p=${serialized};try{if(window.opener)window.opener.postMessage(p,window.location.origin);if("BroadcastChannel"in window){const c=new BroadcastChannel("${escapedChannel}");c.postMessage(p);setTimeout(()=>c.close(),100)}}finally{if(p.ok)setTimeout(()=>window.close(),150)}})();
</script>
</body></html>`;
};

// ---------------------------------------------------------------------------
// Callback wrapper — turns a completeOAuth Effect into a popup HTML string.
// ---------------------------------------------------------------------------

export type OAuthCallbackUrlParams = {
  readonly state: string;
  readonly code?: string | null;
  readonly error?: string | null;
  readonly error_description?: string | null;
};

/** Short summary + optional full technical detail. */
export type PopupErrorMessage = {
  readonly short: string;
  readonly details?: string;
};

export type RunOAuthCallbackInput<TAuth, E, R> = {
  /** The plugin's `completeOAuth` — resolves to the auth descriptor on success. */
  readonly complete: (params: {
    readonly state: string;
    readonly code: string | null;
    readonly error: string | null;
  }) => Effect.Effect<TAuth, E, R>;
  readonly urlParams: OAuthCallbackUrlParams;
  /** Map a plugin-specific error into a short summary and optional details. */
  readonly toErrorMessage: (error: unknown) => PopupErrorMessage;
  readonly channelName: string;
};

/**
 * Run a plugin's `completeOAuth` against URL params from the OAuth redirect,
 * wrap the success / failure in an `OAuthPopupResult`, and return the HTML
 * body ready to hand to `HttpServerResponse.html(...)`.
 *
 * This never fails — errors become a `{ ok: false }` result so the popup
 * can still render and close itself.
 */
export const runOAuthCallback = <TAuth, E, R>(
  input: RunOAuthCallbackInput<TAuth, E, R>,
): Effect.Effect<string, never, R> =>
  input
    .complete({
      state: input.urlParams.state,
      code: input.urlParams.code ?? null,
      error: input.urlParams.error ?? input.urlParams.error_description ?? null,
    })
    .pipe(
      Effect.map(
        (auth): OAuthPopupResult<TAuth> => ({
          type: OAUTH_POPUP_MESSAGE_TYPE,
          ok: true,
          sessionId: input.urlParams.state,
          ...auth,
        }),
      ),
      Effect.catchCause((cause) => {
        const { short, details } = input.toErrorMessage(Cause.squash(cause));
        return Effect.succeed<OAuthPopupResult<TAuth>>({
          type: OAUTH_POPUP_MESSAGE_TYPE,
          ok: false,
          sessionId: input.urlParams.state ?? null,
          error: short,
          ...(details && details !== short ? { errorDetails: details } : {}),
        });
      }),
      Effect.tap((result) =>
        Effect.sync(() => completionListener?.(result as OAuthPopupResult<unknown>)),
      ),
      Effect.map((result) => popupDocument(result, input.channelName)),
    );
