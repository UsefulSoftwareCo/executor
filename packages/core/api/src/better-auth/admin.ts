import { HttpApiBuilder } from "effect/unstable/httpapi";
import { HttpRouter, HttpServerRequest } from "effect/unstable/http";
import { Effect, Layer } from "effect";

import {
  AdminError,
  AdminForbidden,
  AdminHttpApi,
  AdminUnauthorized,
  InviteCode as InviteCodeSchema,
} from "./admin-api";
import { BetterAuth, type BetterAuthHandle } from "./identity";
import {
  createInviteCode,
  listInviteCodes,
  revokeInviteCode,
  type InviteCodeRow,
  type InviteRole,
} from "./invites";

export type AdminGateDenial = "unauthorized" | "forbidden";

export interface InstanceAdmin {
  readonly userId: string;
  readonly role: string;
}

const isPrivileged = (role: string): boolean =>
  role
    .split(",")
    .map((part) => part.trim())
    .some((part) => part === "owner" || part === "admin");

export const requireInstanceAdmin = (
  headers: Headers,
): Effect.Effect<InstanceAdmin, AdminGateDenial, BetterAuth> =>
  Effect.gen(function* () {
    const { auth, organizationId } = yield* BetterAuth;

    const session = yield* Effect.tryPromise(() => auth.api.getSession({ headers })).pipe(
      Effect.orElseSucceed(() => null),
    );
    if (!session) return yield* Effect.fail<AdminGateDenial>("unauthorized");

    const resolved = yield* Effect.tryPromise(() =>
      auth.api.getActiveMemberRole({ headers, query: { organizationId } }),
    ).pipe(Effect.orElseSucceed(() => null));
    if (!resolved || !isPrivileged(resolved.role)) {
      return yield* Effect.fail<AdminGateDenial>("forbidden");
    }

    return { userId: session.user.id, role: resolved.role };
  });

const requestHeaders = Effect.map(
  HttpServerRequest.HttpServerRequest.asEffect(),
  (request): Headers => new Headers({ ...request.headers }),
);

const requireAdmin = (headers: Headers) =>
  requireInstanceAdmin(headers).pipe(
    Effect.mapError((denial) =>
      denial === "unauthorized" ? new AdminUnauthorized() : new AdminForbidden(),
    ),
  );

const narrowRole = (role: string | undefined): InviteRole =>
  role === "admin" ? "admin" : "member";

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
        const { dbClient } = yield* BetterAuth;
        const rows = yield* Effect.tryPromise({
          try: () => listInviteCodes(dbClient),
          catch: () => new AdminError({ message: "Failed to list invites" }),
        });
        return { invites: rows.map(toWire) };
      }),
    )
    .handle("createInvite", ({ payload }) =>
      Effect.gen(function* () {
        const member = yield* requireAdmin(yield* requestHeaders);
        const { dbClient } = yield* BetterAuth;
        const days = payload.expiresInDays ?? null;
        const expiresAt =
          days && days > 0 ? new Date(Date.now() + days * 86_400_000).toISOString() : null;
        const row = yield* Effect.tryPromise({
          try: () =>
            createInviteCode(dbClient, {
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
        const { dbClient } = yield* BetterAuth;
        yield* Effect.tryPromise({
          try: () => revokeInviteCode(dbClient, params.inviteId),
          catch: () => new AdminError({ message: "Failed to revoke invite" }),
        });
        return { success: true };
      }),
    ),
);

export interface BetterAuthAdminApiDeps {
  readonly betterAuth: BetterAuthHandle;
  readonly mountPrefix: `/${string}`;
}

export const makeBetterAuthAdminApiLayer = ({
  betterAuth,
  mountPrefix,
}: BetterAuthAdminApiDeps) => {
  const prefixedRouter = Layer.effect(HttpRouter.HttpRouter)(
    Effect.map(HttpRouter.HttpRouter.asEffect(), (router) => router.prefixed(mountPrefix)),
  );
  return HttpApiBuilder.layer(AdminHttpApi).pipe(
    Layer.provide(AdminHandlers),
    Layer.provide(prefixedRouter),
    HttpRouter.provideRequest(Layer.succeed(BetterAuth)(betterAuth)),
  );
};
