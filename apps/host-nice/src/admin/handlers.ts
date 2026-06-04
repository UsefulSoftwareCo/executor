import { HttpApiBuilder } from "effect/unstable/httpapi";
import { HttpRouter, HttpServerRequest } from "effect/unstable/http";
import { Effect, Layer } from "effect";

import {
  AdminError,
  AdminForbidden,
  AdminHttpApi,
  AdminUnauthorized,
  type InviteCode as InviteCodeSchema,
} from "./api";
import { BetterAuth, type BetterAuthHandle } from "../auth/better-auth";
import { SelfHostDb, type SelfHostDbHandle } from "../db/self-host-db";
import {
  createInviteCode,
  listInviteCodes,
  revokeInviteCode,
  type InviteCodeRow,
  type InviteRole,
} from "../auth/invites";

// ---------------------------------------------------------------------------
// Handlers for the self-host admin (invite-code) API. Every Promise-returning
// boundary (Better Auth, the libSQL store) is wrapped in Effect.tryPromise with
// a typed failure — no raw try/catch, no Promise.catch. Each route is gated:
// the caller must be an owner/admin member of the one org (resolved through the
// org primitive's getActiveMember).
// ---------------------------------------------------------------------------

const requestHeaders = Effect.map(
  HttpServerRequest.HttpServerRequest.asEffect(),
  (request): Headers => new Headers({ ...request.headers }),
);

// Resolve + authorize the caller, returning their member record (for userId).
const requireAdmin = (headers: Headers) =>
  Effect.gen(function* () {
    const { auth } = yield* BetterAuth;
    const member = yield* Effect.tryPromise({
      try: () => auth.api.getActiveMember({ headers }),
      catch: () => new AdminError({ message: "Failed to resolve session" }),
    }).pipe(Effect.orElseSucceed(() => null));
    if (!member) return yield* new AdminUnauthorized();
    if (member.role !== "owner" && member.role !== "admin") return yield* new AdminForbidden();
    return member;
  });

const narrowRole = (role: string | undefined): InviteRole =>
  role === "admin" ? "admin" : "member";

// Drop the internal audit columns (createdBy/usedBy) for the wire shape.
const toWire = (row: InviteCodeRow): typeof InviteCodeSchema.Type => ({
  id: row.id,
  code: row.code,
  role: row.role,
  label: row.label,
  createdAt: row.createdAt,
  expiresAt: row.expiresAt,
  usedByEmail: row.usedByEmail,
  usedAt: row.usedAt,
});

export const AdminHandlers = HttpApiBuilder.group(AdminHttpApi, "admin", (handlers) =>
  handlers
    .handle("listInvites", () =>
      Effect.gen(function* () {
        yield* requireAdmin(yield* requestHeaders);
        const { client } = yield* SelfHostDb;
        const rows = yield* Effect.tryPromise({
          try: () => listInviteCodes(client),
          catch: () => new AdminError({ message: "Failed to list invites" }),
        });
        return { invites: rows.map(toWire) };
      }),
    )
    .handle("createInvite", ({ payload }) =>
      Effect.gen(function* () {
        const member = yield* requireAdmin(yield* requestHeaders);
        const { client } = yield* SelfHostDb;
        const days = payload.expiresInDays ?? null;
        const expiresAt =
          days && days > 0 ? new Date(Date.now() + days * 86_400_000).toISOString() : null;
        const row = yield* Effect.tryPromise({
          try: () =>
            createInviteCode(client, {
              createdBy: member.userId,
              role: narrowRole(payload.role),
              label: payload.label?.trim() ? payload.label.trim() : null,
              expiresAt,
            }),
          catch: () => new AdminError({ message: "Failed to create invite" }),
        });
        return toWire(row);
      }),
    )
    .handle("revokeInvite", ({ params }) =>
      Effect.gen(function* () {
        yield* requireAdmin(yield* requestHeaders);
        const { client } = yield* SelfHostDb;
        yield* Effect.tryPromise({
          try: () => revokeInviteCode(client, params.inviteId),
          catch: () => new AdminError({ message: "Failed to revoke invite" }),
        });
        return { success: true };
      }),
    ),
);

export interface SelfHostAdminApiDeps {
  readonly betterAuth: BetterAuthHandle;
  readonly db: SelfHostDbHandle;
  readonly mountPrefix: `/${string}`;
}

/**
 * The mountable extension route layer: registers the admin routes on the
 * `mountPrefix`-prefixed view of the ambient router (so `/admin/*` is served at
 * `/api/admin/*`). Better Auth + the DB handle are app singletons, provided via
 * `provideRequest` so the handlers' per-request requirement markers are cleared
 * (a plain `Layer.provide` leaves them on the layer's requirement channel). The
 * residual platform/router requirements are cleared by the serve binding — the
 * loose `RouteExtension` channel the app's `extensions.routes` accepts.
 */
export const makeSelfHostAdminApiLayer = ({
  betterAuth,
  db,
  mountPrefix,
}: SelfHostAdminApiDeps) => {
  const prefixedRouter = Layer.effect(HttpRouter.HttpRouter)(
    Effect.map(HttpRouter.HttpRouter.asEffect(), (router) => router.prefixed(mountPrefix)),
  );
  return HttpApiBuilder.layer(AdminHttpApi).pipe(
    Layer.provide(AdminHandlers),
    Layer.provide(prefixedRouter),
    HttpRouter.provideRequest(
      Layer.mergeAll(Layer.succeed(BetterAuth)(betterAuth), Layer.succeed(SelfHostDb)(db)),
    ),
  );
};
