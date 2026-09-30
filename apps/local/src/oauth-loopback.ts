import { Effect } from "effect";

import { OAuthLoopbackListenError, type OAuthLoopbackListenerShape } from "@executor-js/api/server";

// ---------------------------------------------------------------------------
// Loopback OAuth callbacks served by the local daemon (RFC 8252 §7.3).
//
// A provider whose OAuth app was registered by someone else — Slack's MCP
// server, for one — only accepts a redirect URI that is already on that app.
// The user therefore registers ONE loopback URI there and the app declares it;
// this host serves it, so the provider's redirect lands on the daemon instead
// of on a URL nobody answers.
//
// The listener is deliberately dumb: it forwards the provider's query string to
// the daemon's own `/api/oauth/callback`, which already owns completion, the
// popup handoff, and the completion page. There is exactly one implementation of
// "what happens when an authorization code arrives", and it is that route.
//
// It binds `127.0.0.1` on the port the app declared — never `localhost`, and
// never a port of our choosing: the provider compares the redirect URI as a
// string, so anything else is a different URI and is rejected.
// ---------------------------------------------------------------------------

/** Where the provider's redirect is forwarded: the daemon's own completion
 *  route. Its path is fixed (`packages/core/api/src/oauth/api.ts`). */
const DAEMON_CALLBACK_PATH = "/api/oauth/callback";

/** How long a bound callback keeps listening. Flows are user-paced — consent
 *  screens, MFA, an account picker — so this only exists to bound the listener,
 *  not to time the user out. A retry inside the window reuses the listener. */
export const OAUTH_LOOPBACK_TTL_MS = 10 * 60 * 1000;

/** Grace period between handing the browser its redirect and closing the
 *  socket, so the response is on the wire before the listener goes away. */
export const OAUTH_LOOPBACK_CLOSE_DELAY_MS = 1000;

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

const isLoopbackHostname = (hostname: string): boolean =>
  LOOPBACK_HOSTNAMES.has(hostname.trim().toLowerCase());

export interface LocalOAuthLoopbackListener extends OAuthLoopbackListenerShape {
  /** Stop every bound callback. For shutdown and for tests, which must not leak
   *  a listening socket between cases. Idempotent. */
  readonly closeAll: () => void;
}

interface BoundCallback {
  /** Bumped every time the callback is handed to a new flow, so a pending
   *  "close after serving" from the previous flow cannot tear down a listener a
   *  retry has already reclaimed. */
  generation: number;
  timer: ReturnType<typeof setTimeout>;
  readonly server: { stop: (closeActiveConnections?: boolean) => void };
}

/** The `code` a foreign bind failure carries, when it carries one.
 *
 *  `Bun.serve` throws a plain Error, so "the port is taken" can only be read out
 *  of its `code` — a true adapter boundary, and the one place here that looks at
 *  a foreign failure's shape at all. */
interface ForeignBindFailure {
  readonly code?: unknown;
}

const PORT_IN_USE = "EADDRINUSE";

const foreignBindCode = (thrown: unknown): string | null => {
  if (typeof thrown !== "object" || thrown === null) return null;
  const code = (thrown as ForeignBindFailure).code;
  return typeof code === "string" ? code : null;
};

/** The page a browser sees when it reaches a loopback callback URL of a path we
 *  are not serving. Only the declared path is handled, so this is what a
 *  mistyped or stale redirect URI lands on. */
const notFoundHtml = (declaredPath: string): string =>
  [
    '<!doctype html><html><head><meta charset="utf-8"><title>Executor</title></head>',
    '<body style="font-family: system-ui, sans-serif; padding: 2rem; max-width: 40rem">',
    '<h1 style="font-size: 1.1rem">Nothing is registered here</h1>',
    `<p>This Executor is only serving <code>${declaredPath}</code> on this port for the current sign-in.</p>`,
    "<p>Start the sign-in again from Executor and use the callback URL the app shows you.</p>",
    "</body></html>",
  ].join("");

/**
 * The listener a local daemon provides to `OAuthLoopbackListener`.
 *
 * `webBaseUrl` is the daemon's own origin — the same value its OAuth callback is
 * derived from — and the provider's redirect is forwarded there. A daemon served
 * from a non-loopback origin refuses to bind: its browser is on another machine,
 * so a loopback URI on the server would never receive the callback.
 */
export const makeOAuthLoopbackListener = (webBaseUrl: string): LocalOAuthLoopbackListener => {
  const bound = new Map<string, BoundCallback>();

  const close = (url: string): void => {
    const entry = bound.get(url);
    if (entry === undefined) return;
    bound.delete(url);
    clearTimeout(entry.timer);
    entry.server.stop(true);
  };

  const closeAll = (): void => {
    for (const url of [...bound.keys()]) close(url);
  };

  /** Park the listener's TTL, replacing whatever was armed before. */
  const armTtl = (url: string, entry: BoundCallback): void => {
    clearTimeout(entry.timer);
    const timer = setTimeout(() => close(url), OAUTH_LOOPBACK_TTL_MS);
    // A pending sign-in must not keep the daemon alive on its own.
    timer.unref?.();
    entry.timer = timer;
  };

  const listen = (url: string): Effect.Effect<void, OAuthLoopbackListenError> =>
    Effect.suspend(() => {
      const existing = bound.get(url);
      // Already serving this exact callback: a retry — or a second flow for the
      // same app — reclaims it rather than fighting itself for the port. From
      // here the listener is SHARED, so the first completion no longer closes it
      // (see the fetch handler) and its TTL is what bounds it.
      if (existing !== undefined) {
        existing.generation += 1;
        armTtl(url, existing);
        return Effect.void;
      }

      const target = new URL(url);
      const port = Number(target.port);
      const path = target.pathname;

      if (target.port === "") {
        return Effect.fail(
          new OAuthLoopbackListenError({
            url,
            message: `A loopback callback needs an explicit port: ${url}`,
          }),
        );
      }

      if (!isLoopbackHostname(new URL(webBaseUrl).hostname)) {
        return Effect.fail(
          new OAuthLoopbackListenError({
            url,
            message:
              `A loopback callback only works when Executor runs on the same machine as the ` +
              `browser, but this Executor is served at ${webBaseUrl}. Use the callback URL ` +
              `shown in the app instead.`,
          }),
        );
      }

      return Effect.try({
        try: () => {
          const server = Bun.serve({
            hostname: "127.0.0.1",
            port,
            fetch: (request: Request) => {
              const incoming = new URL(request.url);
              if (incoming.pathname !== path) {
                return new Response(notFoundHtml(path), {
                  status: 404,
                  headers: { "content-type": "text/html; charset=utf-8" },
                });
              }
              const entry = bound.get(url);
              // The whole query travels verbatim: `code`/`state` for the exchange,
              // and provider extras (Datadog's `domain`/`site`) that the completion
              // route already knows how to read.
              const destination = new URL(DAEMON_CALLBACK_PATH, webBaseUrl);
              destination.search = incoming.search;
              if (entry !== undefined) {
                // Close behind the response: the browser already has its redirect,
                // and a one-shot loopback callback has no reason to keep the port.
                // ONLY while the listener was never handed to a second flow: two
                // flows can share one declared URI (two tabs connecting the same
                // app), and if the first completion tore the listener down, the
                // second user would finish consenting and hit a refused connection.
                // A shared listener is left to its TTL instead. Re-checked when the
                // timer fires, so a flow that claims the URI in the meantime wins.
                setTimeout(() => {
                  if (bound.get(url)?.generation === 0) close(url);
                }, OAUTH_LOOPBACK_CLOSE_DELAY_MS);
              }
              return Response.redirect(destination.toString(), 302);
            },
          });
          const entry: BoundCallback = { generation: 0, timer: setTimeout(() => {}, 0), server };
          armTtl(url, entry);
          bound.set(url, entry);
        },
        catch: (thrown) =>
          new OAuthLoopbackListenError({
            url,
            message:
              foreignBindCode(thrown) === PORT_IN_USE
                ? `Port ${port} is already in use, so Executor cannot serve ${url}. ` +
                  `Another client (Claude Code, Cursor, …) may be mid-sign-in on that port. ` +
                  `Finish or close that flow, or register a different callback port for this app.`
                : `Could not serve the loopback callback ${url}: this machine refused a ` +
                  `listener on port ${port}. Something else may be holding it.`,
          }),
      });
    });

  return { listen, closeAll };
};
