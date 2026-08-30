/**
 * Local single-user bearer-token handling for the web SPA.
 *
 * The local server mints one bearer token (see `@executor-js/local` auth.json)
 * and gates every `/api` and `/mcp` request on it. This module gets that token
 * into the browser with zero ceremony in the common case:
 *
 *   - Desktop: the Electron main process injects the header at the session
 *     layer, so the renderer never needs the token and this module no-ops.
 *   - Standalone web AND dev (vite): the server prints `…/?_otc=<code>`.
 *     `bootstrapLocalAuthToken` POSTs the code to the exchange endpoint,
 *     receives the bearer in the response body (plus an HttpOnly cookie),
 *     applies it to the in-memory connection, and strips the query. Nothing
 *     is written to localStorage. Dev uses the exact same path — no dev-only
 *     token injection.
 *
 * When a request still 401s (cleared storage, rotated token), the API client
 * calls `notifyLocalAuthRequired()` and `<LocalAuthGate>` prompts for the token.
 */

import * as React from "react";

import { getExecutorServerConnection, setExecutorServerConnection } from "./server-connection";

const STORAGE_KEY = "executor.authToken";
const DESKTOP_LAUNCH_CACHE_BUST_PARAM = "_executor_desktop_launch";

const isDesktopBridge = (): boolean =>
  typeof globalThis.window?.executor?.getServerConnection === "function";

const readStoredToken = (): string | null => {
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: localStorage can throw (private mode / disabled storage)
  try {
    return globalThis.localStorage?.getItem(STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
};

const persistToken = (token: string): void => {
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: localStorage can throw (private mode / disabled storage)
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, token);
  } catch {
    // best-effort; the token still applies for this session
  }
};

const applyBearer = (token: string): void => {
  const current = getExecutorServerConnection();
  // Only standalone web carries the token in the client; desktop injects it.
  if (current.kind !== "http") return;
  setExecutorServerConnection({ ...current, auth: { kind: "bearer", token } });
};

/**
 * Resolve and apply the local bearer token at boot. Call once before the router
 * mounts. Order: `?_token` URL param (one-time, persisted + stripped) →
 * localStorage. Identical in dev and prod.
 */
const EXCHANGE_PATH = "/api/auth/exchange";

/**
 * Exchange a one-time code for the local bearer. The response body carries the
 * token (applied to the in-memory connection) and the server also sets an
 * HttpOnly SameSite=strict cookie (transport hardening; the bearer header
 * remains the /api request gate). Returns true on success.
 */
// oxlint-disable executor/no-try-catch-or-throw -- boundary: browser fetch in a synchronous bootstrap path; any network failure collapses to false and the auth gate renders
const exchangeOtc = async (code: string): Promise<boolean> => {
  try {
    const res = await fetch(EXCHANGE_PATH, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `code=${encodeURIComponent(code)}`,
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { readonly token?: unknown };
    if (typeof body.token !== "string" || body.token.length === 0) return false;
    applyBearer(body.token);
    return true;
  } catch {
    return false;
  }
};
// oxlint-enable executor/no-try-catch-or-throw

export const bootstrapLocalAuthToken = (): Promise<void> | void => {
  const url = globalThis.window ? new URL(window.location.href) : null;
  const fromOtc = url?.searchParams.get("_otc") ?? null;
  const fromUrlToken = url?.searchParams.get("_token") ?? null;
  const stripCacheBust = url?.searchParams.has(DESKTOP_LAUNCH_CACHE_BUST_PARAM) ?? false;
  if (stripCacheBust) {
    url!.searchParams.delete(DESKTOP_LAUNCH_CACHE_BUST_PARAM);
  }

  const stripQuery = (): void => {
    globalThis.window?.history?.replaceState(null, "", url!.pathname + url!.search + url!.hash);
  };

  if (isDesktopBridge()) {
    // Desktop injects the bearer at the session layer; nothing to exchange.
    if (fromOtc) url!.searchParams.delete("_otc");
    if (fromUrlToken) url!.searchParams.delete("_token");
    if (stripCacheBust || fromOtc || fromUrlToken) stripQuery();
    return;
  }

  if (fromOtc) {
    // The code is single-use, so strip the query immediately regardless of
    // outcome (a failed exchange falls through to the stored token or the
    // auth gate). The returned promise is awaited by the caller
    // (entry-client) before the router mounts: the bearer must be on the
    // connection before the first API atom fires, or those atoms 401 and
    // cache the failure state — the auth gate would render even after a
    // successful late exchange.
    url!.searchParams.delete("_otc");
    stripQuery();
    return exchangeOtc(fromOtc).then(() => undefined);
  }

  if (fromUrlToken) {
    // Legacy fallback: dev servers / older daemons may still print ?_token=.
    // Accepted for compatibility but never persisted — the OTC path is the
    // default and this branch is deprecated.
    url!.searchParams.delete("_token");
    stripQuery();
    applyBearer(fromUrlToken);
    return;
  }

  if (stripCacheBust) {
    stripQuery();
  }

  const stored = readStoredToken();
  if (stored) applyBearer(stored);
};

/**
 * Persist a token entered manually (the login gate) and reload. The gate
 * appeared because an API call 401'd, leaving those atoms in a cached failure
 * state; a reload re-bootstraps the whole app with the token from the start so
 * every atom re-fetches with the bearer (rather than dismissing the gate in
 * place onto stale "failed to load" data).
 */
export const setLocalAuthToken = (token: string): void => {
  const trimmed = token.trim();
  if (!trimmed) return;
  persistToken(trimmed);
  if (globalThis.window?.location) {
    globalThis.window.location.reload();
    return;
  }
  applyBearer(trimmed);
  setAuthRequired(false);
};

// --- "auth required" signal -------------------------------------------------

let authRequired = false;
const listeners = new Set<() => void>();

const setAuthRequired = (value: boolean): void => {
  if (authRequired === value) return;
  authRequired = value;
  for (const listener of listeners) listener();
};

/**
 * Signal that a request was rejected as unauthenticated. No-op on desktop (the
 * main process owns the credential) — the gate is only for standalone web.
 */
export const notifyLocalAuthRequired = (): void => {
  if (isDesktopBridge()) return;
  setAuthRequired(true);
};

const useAuthRequired = (): boolean =>
  React.useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    () => authRequired,
    () => false,
  );

// --- Gate UI ----------------------------------------------------------------

/**
 * Renders its children unless a local-auth credential is required, in which
 * case it shows a single-input token entry screen. Mount it around the app
 * shell.
 */
export function LocalAuthGate(props: { readonly children: React.ReactNode }) {
  const required = useAuthRequired();
  const [value, setValue] = React.useState("");

  if (!required) return <>{props.children}</>;

  return (
    <div className="flex h-screen items-center justify-center bg-background p-6">
      <form
        className="flex w-full max-w-sm flex-col gap-3 rounded-xl border border-border bg-card p-6 shadow-sm"
        onSubmit={(event) => {
          event.preventDefault();
          setLocalAuthToken(value);
        }}
      >
        <h1 className="text-base font-semibold text-foreground">Authentication required</h1>
        <p className="text-sm text-muted-foreground">
          Run <code>executor open</code> in your terminal to sign in, or paste the server's token
          below.
        </p>
        {/* oxlint-disable-next-line react/forbid-elements -- token entry input */}
        <input
          type="password"
          autoFocus
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder="Bearer token"
          className="rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
        />
        {/* oxlint-disable-next-line react/forbid-elements -- gate submit button */}
        <button
          type="submit"
          disabled={value.trim().length === 0}
          className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
        >
          Connect
        </button>
      </form>
    </div>
  );
}
