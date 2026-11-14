/**
 * Security audit events for Better Auth's own endpoints: sign-in, one-time codes, sessions, API
 * keys, organization members and invitations, and OAuth client registration and consent.
 *
 * A record names only what the request's authentication and the endpoint's stored result
 * establish. The actor is the session already on the hook context: one a before hook loaded, or
 * the product analytics hook's read of the signed-in session for the operations it counts. Better
 * Auth's endpoint middleware does not leave its own read there. This module never reads a session
 * itself, so auditing adds no query and no cookie to any answer; an endpoint whose session nothing
 * else loaded is recorded without its actor. A target's ID and
 * an organization come from what the endpoint stored and answered with, after it succeeded; a
 * refused request names neither, since what it asked for can be any text. A failure is recorded
 * by Better Auth's code only when the code is one these endpoints answer with (`failureOf`).
 * Never an email address, a code, a token or a key: `/api-key/create` answers with the new key's
 * value beside its ID, and only the ID is read.
 *
 * A session revocation is recorded where Better Auth deletes the session row, one record per
 * deleted session. A revocation endpoint that answers success without deleting one, as sign-out
 * does when the deletion fails, is recorded as `unconfirmed`.
 *
 * An admin's impersonation is its own action, not a sign-in: its actor is the admin and its target
 * the impersonated user, both from the session rows Better Auth stored or deleted. A session an
 * impersonation created carries the admin as `impersonatedBy`, which every record made in it names.
 */
import type { BetterAuthPlugin } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";
import { Option } from "effect";
import type { SecurityAuditAction, SecurityAuditEvent } from "@executor-js/hosted-server";
import {
  audited,
  decodeAccept,
  decodeId,
  decodeKeyId,
  decodeOAuthQuery,
  decodeReturned,
  decodeRole,
  otpChecks,
  outcome,
  revocations,
  signIns,
  type HookContext,
  type Session,
} from "./auth-audit-vocabulary.ts";

/**
 * The audited event for a completed request, or none for an endpoint this module does not audit.
 * `confirmed` tells whether a revocation deleted a session; `impersonated` is the user whose
 * impersonation session `/admin/stop-impersonating` deleted.
 */
const auditedEvent = (
  ctx: HookContext,
  confirmed: boolean,
  impersonated: string | undefined,
): SecurityAuditEvent | undefined => {
  const path = ctx.path ?? "";
  const failure = outcome(ctx);
  const user = ctx.context.session?.user.id;
  // Only a successful endpoint's answer and input name stored records.
  const returned =
    failure === undefined ? Option.getOrUndefined(decodeReturned(ctx.context.returned)) : undefined;
  const event = (
    action: SecurityAuditAction,
    rest: Partial<SecurityAuditEvent> = {},
  ): SecurityAuditEvent => ({
    action,
    outcome: failure === undefined ? "success" : "failure",
    failure,
    user,
    ...rest,
  });
  const method = signIns[path];
  // A sign-in endpoint that created a session signed someone in, and one that reports an error
  // refused a sign-in. Starting a social sign-in, or a social return that links an account to the
  // signed-in user, does neither.
  if (method !== undefined) {
    const created = ctx.context.newSession?.user.id;
    if (created !== undefined)
      return { action: "sign_in", outcome: "success", user: created, detail: { method } };
    return failure === undefined
      ? undefined
      : event("sign_in", { user: undefined, detail: { method } });
  }
  if (otpChecks.has(path)) return failure === undefined ? undefined : event("otp.verify");
  // Each deleted session was recorded where it was deleted.
  if (revocations.has(path)) {
    const kind = path === "/sign-out" ? "session" : "sessions";
    if (failure !== undefined) return event("session.revoke", { target: { kind } });
    return confirmed
      ? undefined
      : event("session.revoke", { outcome: "unconfirmed", target: { kind } });
  }
  const role = Option.match(decodeRole(ctx.body), {
    onNone: () => ({}),
    onSome: (body) => ({ detail: { role: body.role } }),
  });
  switch (path) {
    case "/api-key/create":
      // `apiKeyManagement` creates a pinned key only for an organization its creator belongs to.
      return event("api_key.create", {
        target: { kind: "api_key", id: returned?.id },
        organization: returned?.metadata?.organization,
      });
    case "/api-key/delete":
      // The endpoint deletes only the caller's own key with exactly this ID, and answers with no
      // record, so a deletion names the ID it found.
      return event("api_key.delete", {
        target: {
          kind: "api_key",
          id:
            failure === undefined ? Option.getOrUndefined(decodeKeyId(ctx.body))?.keyId : undefined,
        },
      });
    case "/organization/update-member-role":
      return event("member.role_change", {
        target: { kind: "member", id: returned?.id },
        organization: returned?.organizationId,
        ...role,
      });
    case "/organization/remove-member":
      return event("member.remove", {
        target: { kind: "member", id: returned?.member?.id },
        organization: returned?.member?.organizationId,
      });
    case "/organization/invite-member":
      return event("invitation.create", {
        target: { kind: "invitation", id: returned?.id },
        organization: returned?.organizationId,
        ...role,
      });
    case "/organization/accept-invitation":
      return event("invitation.accept", {
        target: { kind: "invitation", id: returned?.invitation?.id },
        organization: returned?.invitation?.organizationId,
      });
    case "/organization/cancel-invitation":
      return event("invitation.cancel", {
        target: { kind: "invitation", id: returned?.id },
        organization: returned?.organizationId,
      });
    case "/oauth2/register":
      return event("oauth_client.register", {
        target: { kind: "oauth_client", id: returned?.client_id },
      });
    case "/oauth2/consent": {
      // A consent the endpoint accepted names the client its signed query resolved to.
      const query =
        failure === undefined ? Option.getOrUndefined(decodeOAuthQuery(ctx.body)) : undefined;
      const client =
        query === undefined
          ? undefined
          : (new URLSearchParams(query.oauth_query).get("client_id") ?? undefined);
      // The endpoint allows only `accept: true`. A body whose `accept` is not a boolean names no
      // decision; it is never taken for an allow.
      const accept = Option.getOrUndefined(decodeAccept(ctx.body))?.accept;
      return event("oauth.consent", {
        target: { kind: "oauth_client", id: Option.getOrUndefined(decodeId(client)) },
        detail: accept === undefined ? undefined : { decision: accept ? "allow" : "deny" },
      });
    }
    case "/admin/impersonate-user": {
      // The session the endpoint stored is the impersonated user's, and names as `impersonatedBy`
      // the admin whose session the endpoint verified. A refusal names no target.
      const started = failure === undefined ? ctx.context.newSession : undefined;
      return event("impersonation.start", {
        user: started?.session.impersonatedBy ?? user,
        target: { kind: "user", id: started?.user.id },
      });
    }
    case "/admin/stop-impersonating":
      // The endpoint deleted the impersonation session and restored the admin's own, which it
      // checked belongs to the session's `impersonatedBy`.
      return event("impersonation.stop", {
        user: failure === undefined ? (ctx.context.newSession?.user.id ?? user) : user,
        target: { kind: "user", id: failure === undefined ? impersonated : undefined },
      });
    default:
      return undefined;
  }
};

/** A session row Better Auth deleted. */
interface DeletedSession {
  readonly id: string;
  readonly userId: string;
}

/**
 * The plugin. Register it after the product analytics plugin, whose session read it reuses.
 * `record` receives each event with the session that made the request, if one was loaded, and
 * must never reject.
 */
export const authAudit = (
  record: (
    event: SecurityAuditEvent,
    /**
     * The signed-in session that made the request, by its row ID, and the admin who impersonates
     * its user when an impersonation created it.
     */
    session:
      | { readonly id: string; readonly user: string; readonly impersonatedBy?: string | undefined }
      | undefined,
  ) => Promise<void>,
): BetterAuthPlugin => {
  /** Requests, by their hook context, in which a revocation deleted a session. */
  const confirmed = new WeakSet<object>();
  /** Requests, by their hook context, that ended an impersonation: the impersonated user. */
  const impersonations = new WeakMap<object, string>();
  const caller = (session: Session | null | undefined) =>
    session === null || session === undefined
      ? undefined
      : {
          id: session.session.id,
          user: session.user.id,
          ...(typeof session.session.impersonatedBy === "string"
            ? { impersonatedBy: session.session.impersonatedBy }
            : {}),
        };
  return {
    id: "executor-security-audit",
    init: () => ({
      options: {
        databaseHooks: {
          session: {
            delete: {
              after: async (deleted: DeletedSession, context) => {
                const path = context?.path;
                if (context === null || path === undefined) return;
                if (path === "/admin/stop-impersonating") {
                  impersonations.set(context.context, deleted.userId);
                  return;
                }
                if (!revocations.has(path)) return;
                confirmed.add(context.context);
                // Sign-out deletes the session its cookie names, the request's own credential.
                const session =
                  caller(context.context.session) ??
                  (path === "/sign-out" ? { id: deleted.id, user: deleted.userId } : undefined);
                await record(
                  {
                    action: "session.revoke",
                    outcome: "success",
                    target: { kind: "session", id: deleted.id },
                    user: deleted.userId,
                  },
                  session,
                );
              },
            },
          },
        },
      },
    }),
    hooks: {
      after: [
        {
          matcher: (ctx) => audited(ctx.path),
          handler: createAuthMiddleware(async (ctx) => {
            const event = auditedEvent(
              ctx,
              confirmed.has(ctx.context),
              impersonations.get(ctx.context),
            );
            if (event !== undefined) await record(event, caller(ctx.context.session));
          }),
        },
      ],
    },
  };
};
