/**
 * HTTP surface for Executor Browser extension reverse channel.
 *
 *   POST   /api/browser-bridge/session
 *   GET    /api/browser-bridge/session/:id/jobs?waitMs=
 *   POST   /api/browser-bridge/session/:id/result
 *   DELETE /api/browser-bridge/session/:id
 *   GET    /api/browser-bridge/sessions
 *   POST   /api/browser-bridge/call
 */

import {
  callTool,
  createSession,
  deleteSession,
  getSession,
  listSessionsForUser,
  postResult,
  sessionPublicView,
  takeJobs,
} from "./store";

export type AuthSession = {
  user: { id: string; name?: string | null; email?: string | null };
  session?: { activeOrganizationId?: string | null };
};

export type BrowserBridgeHttpDeps = {
  /** Resolve Bearer / API key / cookie session. Return null if unauthenticated. */
  readonly getSession: (request: Request) => Promise<AuthSession | null>;
};

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });

const unauthorized = () => json({ error: "unauthorized" }, 401);
const notFound = (msg = "not found") => json({ error: msg }, 404);
const badRequest = (msg: string) => json({ error: msg }, 400);

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

/**
 * Mount at `/api/browser-bridge/*` (and exact `/api/browser-bridge`).
 */
export function makeBrowserBridgeHandler(deps: BrowserBridgeHttpDeps) {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    // Normalize path: strip /api/browser-bridge prefix
    let path = url.pathname;
    const markers = ["/api/browser-bridge", "/browser-bridge"];
    for (const m of markers) {
      if (path === m || path.startsWith(m + "/")) {
        path = path.slice(m.length) || "/";
        break;
      }
    }

    const auth = await deps.getSession(request);
    if (!auth?.user?.id) return unauthorized();
    const userId = auth.user.id;
    const organizationId = auth.session?.activeOrganizationId || undefined;

    // POST /session
    if (path === "/session" && request.method === "POST") {
      const body = (await readJson(request)) as Record<string, unknown> | null;
      const session = createSession({
        userId,
        organizationId,
        kind: typeof body?.kind === "string" ? body.kind : "chrome-extension",
        transport: typeof body?.transport === "string" ? body.transport : "reverse-longpoll",
        client: (body?.client as Record<string, unknown>) || undefined,
        capabilities: body?.capabilities,
        connection: (body?.connection as Record<string, unknown>) || undefined,
      });
      return json({
        sessionId: session.id,
        id: session.id,
        pollPath: `/api/browser-bridge/session/${session.id}/jobs`,
        resultPath: `/api/browser-bridge/session/${session.id}/result`,
        ...sessionPublicView(session),
      });
    }

    // GET /sessions
    if (path === "/sessions" && request.method === "GET") {
      return json({
        sessions: listSessionsForUser(userId).map(sessionPublicView),
      });
    }

    // POST /call  — agent/HTTP convenience
    if (path === "/call" && request.method === "POST") {
      const body = (await readJson(request)) as {
        tool?: string;
        args?: Record<string, unknown>;
        sessionId?: string;
        timeoutMs?: number;
      } | null;
      if (!body?.tool) return badRequest("tool required");
      try {
        const result = await callTool({
          userId,
          tool: body.tool,
          args: body.args,
          sessionId: body.sessionId,
          timeoutMs: body.timeoutMs,
        });
        return json({ ok: true, result });
      } catch (e) {
        return json({ ok: false, error: String((e as Error)?.message || e) }, 504);
      }
    }

    // /session/:id/...
    const sessionMatch = path.match(/^\/session\/([^/]+)(?:\/(jobs|result))?$/);
    if (sessionMatch) {
      const sessionId = decodeURIComponent(sessionMatch[1]!);
      const sub = sessionMatch[2];

      if (!sub && request.method === "DELETE") {
        const ok = deleteSession(sessionId, userId);
        return ok ? json({ ok: true }) : notFound("session not found");
      }

      if (!sub && request.method === "GET") {
        const s = getSession(sessionId);
        if (!s || s.userId !== userId) return notFound("session not found");
        return json(sessionPublicView(s));
      }

      if (sub === "jobs" && request.method === "GET") {
        const waitMs = Number(url.searchParams.get("waitMs") || "25000");
        try {
          const jobs = await takeJobs(sessionId, userId, waitMs);
          return json({ jobs });
        } catch (e) {
          return notFound(String((e as Error)?.message || e));
        }
      }

      if (sub === "result" && request.method === "POST") {
        const body = (await readJson(request)) as {
          jobId?: string;
          result?: unknown;
        } | null;
        if (!body?.jobId) return badRequest("jobId required");
        const ok = postResult(sessionId, userId, body.jobId, body.result);
        return ok ? json({ ok: true }) : notFound("job not found");
      }
    }

    return notFound(`unknown browser-bridge path ${path}`);
  };
}
