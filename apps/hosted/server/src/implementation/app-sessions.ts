import { resolveOrganizationReference } from "./organization-reference.ts";
import type { AuthContext } from "@better-auth/core";
import { AppSignInId } from "apps/ui/auth/contracts";
import { UiFailed, UiForbidden, UiUnauthorized } from "apps/ui/contracts";
import { refuse } from "./auth-telemetry.ts";
import { Clock, Effect, Redacted, Result, Schema } from "effect";
import {
  AppUiAttempt,
  AppUiGrant,
  AppUiLaunch,
  AppUiRecord,
  AppUiSession,
  HostedAppSessions,
  type AppUiParent,
  type AppUiTarget,
} from "../contracts/app-ui.ts";
import { Principal } from "../contracts/auth.ts";
import {
  OrganizationId,
  OrganizationRole,
  OrganizationSlug,
  organizationOwner,
} from "../contracts/organization.ts";

const unavailable = () => new UiFailed({ reason: "unavailable" });
const sameTarget = (a: AppUiTarget, b: AppUiTarget) =>
  a.app === b.app &&
  a.organization === b.organization &&
  a.origin === b.origin &&
  a.slug === b.slug;
const Parent = Schema.Struct({
  userId: Principal.fields.userId,
  expiresAt: Schema.Date,
  impersonatedBy: Schema.optional(Schema.NullOr(Principal.fields.userId)),
});
const Key = Schema.Struct({
  referenceId: Schema.String,
  enabled: Schema.optional(Schema.NullOr(Schema.Boolean)),
  remaining: Schema.optional(Schema.NullOr(Schema.Number)),
  expiresAt: Schema.optional(Schema.NullOr(Schema.Date)),
});
const hour = 60 * 60_000;
const week = 7 * 24 * hour;
const Organization = Schema.Struct({ id: OrganizationId, slug: OrganizationSlug });
const Membership = Schema.Struct({ role: OrganizationRole });
const Stored = Schema.Struct({ value: Schema.String, expiresAt: Schema.Date });
const recordJson = Schema.fromJsonString(AppUiRecord);
const inOrder = <A, B, E1, E2>(first: Effect.Effect<A, E1>, second: Effect.Effect<B, E2>) =>
  Effect.all([Effect.result(first), Effect.result(second)], { concurrency: "unbounded" }).pipe(
    Effect.flatMap(([a, b]) =>
      Result.isFailure(a)
        ? Effect.fail<E1 | E2>(a.failure)
        : Result.isFailure(b)
          ? Effect.fail<E1 | E2>(b.failure)
          : Effect.succeed([a.success, b.success] as const),
    ),
  );

export const hostedAppSessions = (
  context: {
    readonly internalAdapter: Pick<
      AuthContext["internalAdapter"],
      "createVerificationValue" | "findVerificationValue" | "consumeVerificationValue"
    >;
    readonly adapter: Pick<AuthContext["adapter"], "findOne" | "findMany">;
  },
  crypto: Crypto,
) => {
  const query = <A>(call: () => Promise<A>) => Effect.tryPromise({ try: call, catch: unavailable });
  const nonce = Effect.sync(() =>
    Redacted.make(
      Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join(""),
    ),
  );
  const digest = (value: Redacted.Redacted<string>) =>
    query(async () =>
      Array.from(
        new Uint8Array(
          await crypto.subtle.digest("SHA-256", new TextEncoder().encode(Redacted.value(value))),
        ),
        (byte) => byte.toString(16).padStart(2, "0"),
      ).join(""),
    );
  const key = (kind: "attempt" | "grant" | "launch" | "session", id: string) =>
    `executor-app-ui:v1:${kind}:${id}`;
  const put = (identifier: string, value: typeof AppUiRecord.Type, expiresAt: Date) =>
    Schema.encodeEffect(recordJson)(value).pipe(
      Effect.mapError(unavailable),
      Effect.flatMap((value) =>
        query(() =>
          context.internalAdapter.createVerificationValue({ identifier, value, expiresAt }),
        ),
      ),
      Effect.asVoid,
    );
  const read = (identifier: string, consume = false) =>
    Effect.gen(function* () {
      const row = yield* query(() =>
        consume
          ? context.internalAdapter.consumeVerificationValue(identifier)
          : context.internalAdapter.findVerificationValue(identifier),
      );
      if (row === null) return yield* refuse("unknown", new UiUnauthorized());
      const stored = yield* Schema.decodeUnknownEffect(Stored)(row).pipe(
        Effect.mapError(unavailable),
      );
      if (stored.expiresAt.getTime() <= (yield* Clock.currentTimeMillis))
        return yield* refuse("expired", new UiUnauthorized());
      return yield* Schema.decodeUnknownEffect(recordJson)(stored.value).pipe(
        Effect.mapError(unavailable),
      );
    });
  const session = (id: typeof Principal.Type.sessionId, user: typeof Principal.Type.userId) =>
    Effect.gen(function* () {
      const row = yield* query(() =>
        context.adapter.findOne({
          model: "session",
          where: [{ field: "id", value: id }],
          select: ["userId", "expiresAt", "impersonatedBy"],
        }),
      );
      if (row === null) return yield* refuse("revoked", new UiUnauthorized());
      const session = yield* Schema.decodeUnknownEffect(Parent)(row).pipe(
        Effect.mapError(unavailable),
      );
      if (session.userId !== user) return yield* refuse("wrong_resource", new UiUnauthorized());
      if (session.expiresAt.getTime() <= (yield* Clock.currentTimeMillis))
        return yield* refuse("expired", new UiUnauthorized());
      return session;
    });
  const apiKey = (id: string, user: typeof Principal.Type.userId) =>
    Effect.gen(function* () {
      const row = yield* query(() =>
        context.adapter.findOne({
          model: "apikey",
          where: [{ field: "id", value: id }],
          select: Object.keys(Key.fields),
        }),
      );
      if (row === null) return yield* refuse("revoked", new UiUnauthorized());
      const key = yield* Schema.decodeUnknownEffect(Key)(row).pipe(Effect.mapError(unavailable));
      if (key.referenceId !== user) return yield* refuse("wrong_resource", new UiUnauthorized());
      if (key.enabled === false || (key.remaining ?? null) !== null)
        return yield* refuse("revoked", new UiUnauthorized());
      const expiresAt = key.expiresAt ?? undefined;
      if (expiresAt !== undefined && expiresAt.getTime() <= (yield* Clock.currentTimeMillis))
        return yield* refuse("expired", new UiUnauthorized());
      return expiresAt;
    });
  const login = (parent: AppUiParent, user: typeof Principal.Type.userId) =>
    Effect.gen(function* () {
      if (typeof parent !== "string")
        return { expiresAt: yield* apiKey(parent.id, user), impersonatedBy: undefined };
      const live = yield* session(parent, user);
      return { expiresAt: live.expiresAt, impersonatedBy: live.impersonatedBy };
    });
  const open = (
    target: AppUiTarget,
    parent: AppUiParent,
    user: typeof Principal.Type.userId,
    parentExpiresAt: Date | undefined,
    lifetime: number,
  ) =>
    Effect.gen(function* () {
      const token = yield* nonce;
      const latest = (yield* Clock.currentTimeMillis) + lifetime;
      const expiresAt = new Date(Math.min(parentExpiresAt?.getTime() ?? latest, latest));
      yield* put(
        key("session", yield* digest(token)),
        { kind: "session", target, parent, user },
        expiresAt,
      );
      return { token, expiresAt };
    });
  const membership = (
    user: typeof Principal.Type.userId,
    target: Pick<AppUiTarget, "organization">,
  ) =>
    Effect.gen(function* () {
      const row = yield* query(() =>
        context.adapter.findOne({
          model: "member",
          where: [
            { field: "userId", value: user },
            { field: "organizationId", value: target.organization },
          ],
          select: ["role"],
        }),
      );
      if (row === null) return yield* refuse("not_member", new UiForbidden());
      const member = yield* Schema.decodeUnknownEffect(Membership)(row).pipe(
        Effect.mapError(() => new UiForbidden()),
      );
      return {
        organization: target.organization,
        owner: organizationOwner(target.organization),
        role: member.role,
      };
    });
  const access = (principal: typeof Principal.Type, target: Pick<AppUiTarget, "organization">) =>
    inOrder(
      session(principal.sessionId, principal.userId),
      membership(principal.userId, target),
    ).pipe(Effect.map(([, access]) => access));
  return HostedAppSessions.of({
    organization: (find) =>
      Effect.gen(function* () {
        const target =
          "reference" in find
            ? {
                id: yield* resolveOrganizationReference(context.adapter, find.reference).pipe(
                  Effect.catchTags({
                    OrganizationForbidden: () =>
                      refuse("organization_not_found", new UiForbidden()),
                    AuthenticationUnavailable: () => Effect.fail(unavailable()),
                  }),
                ),
              }
            : find;
        const row = yield* query(() =>
          context.adapter.findOne({
            model: "organization",
            where: [
              "id" in target
                ? { field: "id", value: target.id }
                : { field: "slug", value: target.slug },
            ],
            select: ["id", "slug"],
          }),
        );
        if (row === null) return yield* refuse("organization_not_found", new UiForbidden());
        return yield* Schema.decodeUnknownEffect(Organization)(row).pipe(
          Effect.mapError(unavailable),
        );
      }),
    access,
    begin: (target, returnTo) =>
      Effect.gen(function* () {
        const request = AppSignInId.make(Redacted.value(yield* nonce));
        const proof = yield* nonce;
        yield* put(
          key("attempt", request),
          { kind: "attempt", target, returnTo, proof: yield* digest(proof) },
          new Date((yield* Clock.currentTimeMillis) + 10 * 60_000),
        );
        return { request, proof };
      }),
    pending: (request) =>
      read(key("attempt", request)).pipe(
        Effect.flatMap((attempt) =>
          Schema.is(AppUiAttempt)(attempt)
            ? Effect.succeed(attempt.target)
            : Effect.fail(unavailable()),
        ),
      ),
    grant: (request, target, principal) =>
      Effect.gen(function* () {
        const code = yield* nonce;
        yield* put(
          key("grant", yield* digest(code)),
          { kind: "grant", request, target, parent: principal.sessionId, user: principal.userId },
          new Date((yield* Clock.currentTimeMillis) + 60_000),
        );
        return code;
      }),
    complete: (target, request, code, proof) =>
      Effect.gen(function* () {
        const attemptKey = key("attempt", request);
        const grantKey = key("grant", yield* digest(code));
        const [attempt, grant, verifier] = yield* Effect.all(
          [read(attemptKey), read(grantKey), digest(proof)],
          { concurrency: "unbounded" },
        );
        if (
          !Schema.is(AppUiAttempt)(attempt) ||
          !Schema.is(AppUiGrant)(grant) ||
          grant.request !== request ||
          !sameTarget(attempt.target, target) ||
          !sameTarget(grant.target, target) ||
          attempt.proof !== verifier
        )
          return yield* new UiUnauthorized();
        const [parent] = yield* inOrder(
          session(grant.parent, grant.user),
          membership(grant.user, target),
        );
        yield* Effect.all([read(attemptKey, true), read(grantKey, true)], {
          concurrency: "unbounded",
        });
        const opened = yield* open(target, grant.parent, grant.user, parent.expiresAt, week);
        return { ...opened, returnTo: attempt.returnTo };
      }),
    launch: (target, user, parent) =>
      Effect.gen(function* () {
        const code = yield* nonce;
        yield* put(
          key("launch", yield* digest(code)),
          { kind: "launch", target, parent, user },
          new Date((yield* Clock.currentTimeMillis) + 60_000),
        );
        return code;
      }),
    redeem: (target, code) =>
      Effect.gen(function* () {
        const launch = yield* read(key("launch", yield* digest(code)), true);
        if (!Schema.is(AppUiLaunch)(launch) || !sameTarget(launch.target, target))
          return yield* refuse("wrong_resource", new UiUnauthorized());
        const [parent] = yield* inOrder(
          login(launch.parent, launch.user),
          membership(launch.user, target),
        );
        return yield* open(target, launch.parent, launch.user, parent.expiresAt, hour);
      }),
    current: (target, token) =>
      Effect.gen(function* () {
        const session = yield* read(key("session", yield* digest(token)));
        if (!Schema.is(AppUiSession)(session) || !sameTarget(session.target, target))
          return yield* refuse("wrong_resource", new UiUnauthorized());
        const parent = yield* login(session.parent, session.user);
        return typeof parent.impersonatedBy === "string"
          ? { userId: session.user, impersonatedBy: parent.impersonatedBy }
          : { userId: session.user };
      }),
  });
};
