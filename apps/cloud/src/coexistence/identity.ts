/** Private rollout boundary; existing auth providers still own credential and membership checks. */
import { timingSafeEqual } from "node:crypto";
import { Effect, Predicate } from "effect";
import { McpAuthProvider } from "@executor-js/host-mcp";
import { cloudMcpAuth } from "../mcp/auth-provider";
import { prepareMcpOrgScope } from "../mcp/mount";
import { CoreSharedServices, WorkOSClient } from "../auth/workos";
import { authorizeOrganizationSelector } from "../auth/organization";
import { RequestScopedServicesLive } from "../api/layers";

const reply = (body: unknown, status = 200): Response =>
  Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
const keyMatches = (expected: string, actual: string): boolean => {
  const encoder = new TextEncoder();
  const left = encoder.encode(expected);
  const right = encoder.encode(actual);
  return left.length === right.length && timingSafeEqual(left, right);
};

/** Disabled unless explicitly configured. It never returns a token, email, or credential. */
export const coexistenceIdentity = (
  request: Request,
  secret: string | undefined,
): Promise<Response> => {
  const supplied = request.headers.get("x-executor-coexistence-key");
  if (!secret || secret.length < 32 || !supplied || !keyMatches(secret, supplied))
    return Promise.resolve(reply({ error: "Not found" }, 404));
  if (request.method !== "GET") return Promise.resolve(reply({ error: "Method not allowed" }, 405));
  const url = new URL(request.url);
  const kind = url.searchParams.get("kind");
  const selector = url.searchParams.get("organization");
  const mcp = Effect.gen(function* () {
    const auth = yield* McpAuthProvider;
    const target = new URL(
      selector === null ? "/mcp" : `/${encodeURIComponent(selector)}/mcp`,
      request.url,
    );
    const outcome = yield* auth.authenticate(
      prepareMcpOrgScope(new Request(target, { headers: request.headers })),
    );
    if (Predicate.isTagged(outcome, "Authenticated")) {
      const principal = outcome.principal;
      return reply({
        userId: principal.accountId,
        organizationId: principal.organizationId,
        organizationSlug: principal.organizationSlug ?? null,
        role: principal.orgRole,
      });
    }
    if (Predicate.isTagged(outcome, "Unauthorized")) return reply({ error: "Unauthorized" }, 401);
    if (Predicate.isTagged(outcome, "Forbidden")) return reply({ error: "Forbidden" }, 403);
    return reply({ error: "Authentication unavailable" }, 503);
  }).pipe(Effect.provide(cloudMcpAuth));
  const browser = Effect.gen(function* () {
    const workos = yield* WorkOSClient;
    const session = yield* workos.authenticateRequest(request);
    if (session === null) return reply({ error: "Unauthorized" }, 401);
    const organization = selector ?? session.organizationId;
    if (!organization) return reply({ error: "Organization required" }, 403);
    const membership = yield* authorizeOrganizationSelector(session.userId, organization);
    if (membership === null) return reply({ error: "Forbidden" }, 403);
    return reply({
      userId: session.userId,
      organizationId: membership.id,
      organizationSlug: membership.slug ?? null,
      role: membership.memberRole,
    });
  }).pipe(Effect.provide(RequestScopedServicesLive), Effect.provide(CoreSharedServices));
  if (kind !== "mcp" && kind !== "browser")
    return Promise.resolve(reply({ error: "Invalid identity kind" }, 400));
  return Effect.runPromise(
    (kind === "mcp" ? mcp : browser).pipe(
      Effect.scoped,
      Effect.catchCause(() => Effect.succeed(reply({ error: "Authentication unavailable" }, 503))),
    ),
  );
};
