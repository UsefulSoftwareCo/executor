// ---------------------------------------------------------------------------
// SSR auth gate — the server-side session check for DOCUMENT requests.
//
// The sealed `wos-session` cookie is verified right here in the worker
// (unseal + JWT check against cached JWKS — no per-request WorkOS round trip
// except token refresh), so by the time the SPA is served the server KNOWS
// who it's serving:
//
// - signed out → 302 /login (carrying ?returnTo=) before any app HTML exists
// - org-less   → 302 /create-org (onboarding owns those sessions)
// - signed in  → the document is served WITH the verified identity: the
//   auth-hint travels to the SSR render via request-middleware context (the
//   root loader picks it up), and is minted as a cookie when the browser
//   doesn't hold a current one — so the very first paint is the real app
//   shell, never a skeleton. The hint is display-only; /account/me remains
//   the authority and the client keeps it fresh from then on.
//
// Scope: GET/HEAD requests that are document navigations (sec-fetch-dest /
// accept), excluding app-owned paths (/api, /mcp — they answer for themselves
// earlier in the middleware chain). Everything else passes through untouched.
// ---------------------------------------------------------------------------

import { createMiddleware } from "@tanstack/react-start";
import { Effect, Exit, Layer, ManagedRuntime } from "effect";

import {
  AUTH_HINT_COOKIE,
  AUTH_HINT_MAX_AGE_SECONDS,
  decodeAuthHint,
  encodeAuthHint,
  type AuthHint,
} from "@executor-js/react/multiplayer/auth-hint";

import { isAppOwnedPath } from "../app-paths";
import { makeDbLayer } from "../db/db";
import { makeUserStoreLayer, UserStoreService } from "./context";
import { parseCookie } from "./cookies";
import { sealedSessionDisplayName } from "./middleware";
import { browserOriginFromRequest } from "./request-origin";
import { loginPath, safeReturnTo } from "./return-to";
import { ONBOARDING_PATHS, PUBLIC_PATHS } from "./route-paths";
import { WorkOSClient } from "./workos";

const SESSION_COOKIE = "wos-session";
/** Mirrors the handlers' COOKIE_OPTIONS (path /, HttpOnly, Lax, 7d, Secure). */
const SESSION_COOKIE_ATTRIBUTES = "Path=/; HttpOnly; Secure; SameSite=Lax";
const SESSION_MAX_AGE = 60 * 60 * 24 * 7;
/** Same attributes the client write uses — minus HttpOnly: the SPA reads it. */
const HINT_COOKIE_ATTRIBUTES = "Path=/; Secure; SameSite=Lax";

const isDocumentRequest = (request: Request): boolean => {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  // Browsers label navigations explicitly; non-browser clients fall back to
  // content negotiation. Anything that isn't asking for a page (vite module
  // requests, JSON fetches, health probes) passes through ungated.
  const dest = request.headers.get("sec-fetch-dest");
  if (dest !== null) return dest === "document";
  return request.headers.get("accept")?.includes("text/html") ?? false;
};

// Lazy for the same reason start.ts instantiates the app handler lazily: this
// module reaches workers-only imports (cloudflare:workers via ./workos), which
// must stay behind the stripped `.server()` callback so the client bundle
// never pulls them in. One runtime per isolate — the WorkOS client holds no
// sockets, just config and a JWKS cache, so sharing it across requests is
// exactly what the unified app handler already does.
let runtime: ManagedRuntime.ManagedRuntime<WorkOSClient, unknown> | undefined;
const getRuntime = () => (runtime ??= ManagedRuntime.make(WorkOSClient.Default));

type VerifiedSession = {
  readonly userId: string;
  readonly email: string;
  readonly name: string | null;
  readonly avatarUrl: string | null;
  readonly organizationId: string | null;
  readonly refreshedSession?: string | undefined;
};

// EVERY failure collapses to "signed out" — WorkOS errors inside the effect
// and layer-construction errors like a bad cookie password (runPromiseExit
// carries those in its Exit too) — so the login flow surfaces the real
// problem instead of 500ing every page.
const verifySession = async (sealed: string): Promise<VerifiedSession | null> => {
  const exit = await getRuntime().runPromiseExit(
    Effect.flatMap(WorkOSClient.asEffect(), (workos) => workos.authenticateSealedSession(sealed)),
  );
  if (!Exit.isSuccess(exit) || exit.value === null) return null;
  const result = exit.value;
  return {
    userId: result.userId,
    email: result.email,
    name: sealedSessionDisplayName(result),
    avatarUrl: result.avatarUrl ?? null,
    organizationId: result.organizationId ?? null,
    refreshedSession: result.refreshedSession,
  };
};

// ── Auth hint ────────────────────────────────────────────────────────────────

/**
 * The hint this request should be served with: the browser's own cookie when
 * it already matches the verified identity, else one minted fresh from the
 * session. `mint` is set when the cookie must also be (re)written — identity
 * data freshness (a renamed user/org) is the CLIENT's job via /account/me,
 * so the gate only steps in when the ids are wrong, never to rewrite display
 * fields (which would ping-pong with the client's authoritative write).
 */
const resolveAuthHint = async (
  session: VerifiedSession,
  cookieHeader: string | null,
): Promise<{ hint: AuthHint; mint: boolean }> => {
  const existing = decodeAuthHint(parseCookie(cookieHeader, AUTH_HINT_COOKIE));
  if (
    existing &&
    existing.user.id === session.userId &&
    (existing.organization?.id ?? null) === session.organizationId
  ) {
    return { hint: existing, mint: false };
  }
  return {
    hint: {
      v: 1,
      user: {
        id: session.userId,
        email: session.email,
        name: session.name,
        avatarUrl: session.avatarUrl,
      },
      organization: session.organizationId
        ? {
            id: session.organizationId,
            ...(await organizationDisplay(session.organizationId)),
          }
        : null,
    },
    mint: true,
  };
};

// The sealed session carries the org ID but not its name/slug; the local
// mirror has both (every org row is born with a slug — see
// `upsertOrganization`). Only consulted when minting the hint (absent/mismatched
// cookie) — never on the steady-state path — and over per-request layers,
// because a connection cached in the shared runtime would be reused across
// requests, which Cloudflare forbids. A miss or failure reads as empty strings
// — display-only, corrected by the client's /account/me write.
const organizationDisplay = async (
  organizationId: string,
): Promise<{ name: string; slug: string }> => {
  const exit = await getRuntime().runPromiseExit(
    Effect.flatMap(UserStoreService.asEffect(), (users) =>
      users.use((store) => store.getOrganization(organizationId)),
    ).pipe(Effect.provide(Layer.provide(makeUserStoreLayer(), makeDbLayer()))),
  );
  return Exit.isSuccess(exit)
    ? { name: exit.value?.name ?? "", slug: exit.value?.slug ?? "" }
    : { name: "", slug: "" };
};

const hintSetCookie = (hint: AuthHint) =>
  `${AUTH_HINT_COOKIE}=${encodeAuthHint(hint)}; ${HINT_COOKIE_ATTRIBUTES}; Max-Age=${AUTH_HINT_MAX_AGE_SECONDS}`;

const sessionSetCookie = (sealed: string) =>
  `${SESSION_COOKIE}=${sealed}; ${SESSION_COOKIE_ATTRIBUTES}; Max-Age=${SESSION_MAX_AGE}`;

const redirect = (
  location: string,
  options?: {
    /** Drop the (invalid) session + auth-hint cookies along the way. */
    readonly clearSession?: boolean;
    /** Persist a WorkOS-rotated sealed session (refresh tokens are single-use). */
    readonly refreshedSession?: string | undefined;
  },
): Response => {
  const headers = new Headers({ location });
  if (options?.clearSession) {
    headers.append("set-cookie", `${SESSION_COOKIE}=; ${SESSION_COOKIE_ATTRIBUTES}; Max-Age=0`);
    headers.append("set-cookie", `${AUTH_HINT_COOKIE}=; Path=/; SameSite=Lax; Max-Age=0`);
  }
  if (options?.refreshedSession) {
    headers.append("set-cookie", sessionSetCookie(options.refreshedSession));
  }
  return new Response(null, { status: 302, headers });
};

export const authGateMiddleware = createMiddleware({ type: "request" }).server(
  async ({ pathname, request, next }) => {
    if (isAppOwnedPath(pathname) || !isDocumentRequest(request)) return next();

    const cookieHeader = request.headers.get("cookie");
    const sealed = parseCookie(cookieHeader, SESSION_COOKIE);
    const url = new URL(request.url);

    // Public pages are what signed-out visitors are FOR; a signed-in visitor
    // landing on /login is bounced straight back to where they were headed.
    if (PUBLIC_PATHS.has(pathname)) {
      const session = sealed ? await verifySession(sealed) : null;
      if (!session) return next();
      return redirect(safeReturnTo(url.searchParams.get("returnTo")) ?? "/", {
        refreshedSession: session.refreshedSession,
      });
    }

    // Marketing CTAs link to /cloud, which is not a route — it's "open the
    // app". Send it to the root (the gate below decides app vs login).
    const returnTo = pathname === "/cloud" ? "/" : `${pathname}${url.search}`;

    if (!sealed) return redirect(loginPath(returnTo));

    const session = await verifySession(sealed);
    if (!session) {
      // A cookie that doesn't verify is worse than none: on executor.sh its
      // mere presence keeps routing / into the app instead of marketing.
      return redirect(loginPath(returnTo), { clearSession: true });
    }

    if (pathname === "/cloud") {
      return redirect("/", { refreshedSession: session.refreshedSession });
    }

    // A session with no organization belongs in onboarding — same decision
    // the client AuthGate makes mid-session, made here before the document
    // exists so the app shell is never painted for an org-less session.
    if (!session.organizationId && !ONBOARDING_PATHS.has(pathname)) {
      return redirect("/create-org", { refreshedSession: session.refreshedSession });
    }

    // Serve the document WITH the verified identity: the hint rides to the
    // SSR render through middleware context (the root loader reads it), so
    // the server paints the real authenticated shell — no loading state, no
    // skeleton. The request origin rides along too: it's what the connect
    // card's MCP URL is built from, and the server knows it (the SPA only
    // learns `window.location.origin` after mount), so passing it here lets
    // SSR render the real `https://…/<org>/mcp` instead of the client-side
    // `http://127.0.0.1:4000` default — which would otherwise flash until
    // hydration corrected it. Set-cookie writes ride on the rendered response.
    const { hint, mint } = await resolveAuthHint(session, cookieHeader);
    const result = await next({
      context: { authHint: hint, origin: browserOriginFromRequest(request) },
    });
    if (!mint && !session.refreshedSession) return result;

    const response = new Response(result.response.body, result.response);
    if (mint) {
      // The browser holds no current hint — mint one so the NEXT load (and
      // any client-side read) sees the same identity this render used.
      response.headers.append("set-cookie", hintSetCookie(hint));
    }
    if (session.refreshedSession) {
      // WorkOS refresh tokens are single-use: the rotated sealed session MUST
      // reach the browser or the next expiry logs the user out.
      response.headers.append("set-cookie", sessionSetCookie(session.refreshedSession));
    }
    return { ...result, response };
  },
);
