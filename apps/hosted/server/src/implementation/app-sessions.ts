import { resolveOrganizationReference } from "./organization-reference.ts";
/** Better Auth owns persistence and atomic consume; no schema or dashboard-token copies are introduced. */
import type { AuthContext } from "@better-auth/core";
import { AppSignInId } from "apps/ui/auth/contracts";
import { UiFailed, UiForbidden, UiUnauthorized } from "apps/ui/contracts";
import { Clock, Effect, Redacted, Schema } from "effect";
import {
  AppUiAttempt,
  AppUiGrant,
  AppUiRecord,
  AppUiSession,
  HostedAppSessions,
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
const Parent = Schema.Struct({ userId: Principal.fields.userId, expiresAt: Schema.Date });
const Organization = Schema.Struct({ id: OrganizationId, slug: OrganizationSlug });
const Membership = Schema.Struct({ role: OrganizationRole });
const Stored = Schema.Struct({ value: Schema.String, expiresAt: Schema.Date });
const recordJson = Schema.fromJsonString(AppUiRecord);

/** Adapt one existing Better Auth context. Persisted state works across restarts and serving processes. */
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
  const key = (kind: "attempt" | "grant" | "session", id: string) =>
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
      if (row === null) return yield* new UiUnauthorized();
      const stored = yield* Schema.decodeUnknownEffect(Stored)(row).pipe(
        Effect.mapError(unavailable),
      );
      if (stored.expiresAt.getTime() <= (yield* Clock.currentTimeMillis))
        return yield* new UiUnauthorized();
      return yield* Schema.decodeUnknownEffect(recordJson)(stored.value).pipe(
        Effect.mapError(unavailable),
      );
    });
  const parent = (id: typeof Principal.Type.sessionId, user: typeof Principal.Type.userId) =>
    Effect.gen(function* () {
      const row = yield* query(() =>
        context.adapter.findOne({
          model: "session",
          where: [{ field: "id", value: id }],
          select: ["userId", "expiresAt"],
        }),
      );
      if (row === null) return yield* new UiUnauthorized();
      const session = yield* Schema.decodeUnknownEffect(Parent)(row).pipe(
        Effect.mapError(unavailable),
      );
      if (
        session.userId !== user ||
        session.expiresAt.getTime() <= (yield* Clock.currentTimeMillis)
      )
        return yield* new UiUnauthorized();
      return session;
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
      if (row === null) return yield* new UiForbidden();
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
    parent(principal.sessionId, principal.userId).pipe(
      Effect.andThen(membership(principal.userId, target)),
    );
  return HostedAppSessions.of({
    organization: (find) =>
      Effect.gen(function* () {
        const target =
          "reference" in find
            ? {
                id: yield* resolveOrganizationReference(context.adapter, find.reference).pipe(
                  Effect.catchTags({
                    OrganizationForbidden: () => Effect.fail(new UiForbidden()),
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
        if (row === null) return yield* new UiForbidden();
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
    authorize: (request, principal) =>
      Effect.gen(function* () {
        const attempt = yield* read(key("attempt", request));
        if (!Schema.is(AppUiAttempt)(attempt)) return yield* unavailable();
        yield* access(principal, attempt.target);
        const code = yield* nonce;
        yield* put(
          key("grant", yield* digest(code)),
          {
            kind: "grant",
            request,
            target: attempt.target,
            parent: principal.sessionId,
            user: principal.userId,
          },
          new Date((yield* Clock.currentTimeMillis) + 60_000),
        );
        return { target: attempt.target, code };
      }),
    complete: (target, request, code, proof) =>
      Effect.gen(function* () {
        const attemptKey = key("attempt", request);
        const grantKey = key("grant", yield* digest(code));
        const attempt = yield* read(attemptKey);
        const grant = yield* read(grantKey);
        if (
          !Schema.is(AppUiAttempt)(attempt) ||
          !Schema.is(AppUiGrant)(grant) ||
          grant.request !== request ||
          !sameTarget(attempt.target, target) ||
          !sameTarget(grant.target, target) ||
          attempt.proof !== (yield* digest(proof))
        )
          return yield* new UiUnauthorized();
        const session = yield* parent(grant.parent, grant.user);
        yield* membership(grant.user, target);
        // Only one callback across all issued codes may consume this browser attempt.
        yield* read(attemptKey, true);
        yield* read(grantKey, true);
        const token = yield* nonce;
        const expiresAt = new Date(
          Math.min(
            session.expiresAt.getTime(),
            (yield* Clock.currentTimeMillis) + 7 * 24 * 60 * 60_000,
          ),
        );
        yield* put(
          key("session", yield* digest(token)),
          { kind: "session", target, parent: grant.parent, user: grant.user },
          expiresAt,
        );
        return { token, returnTo: attempt.returnTo, expiresAt };
      }),
    current: (target, token) =>
      Effect.gen(function* () {
        const session = yield* read(key("session", yield* digest(token)));
        if (!Schema.is(AppUiSession)(session) || !sameTarget(session.target, target))
          return yield* new UiUnauthorized();
        yield* parent(session.parent, session.user);
        // The serving host checks current membership together with app/account
        // permissions. A second lookup here adds no authority to that decision.
        return { userId: session.user };
      }),
  });
};
