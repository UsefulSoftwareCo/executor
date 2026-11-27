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

const auditedEvent = (
  ctx: HookContext,
  confirmed: boolean,
  impersonated: string | undefined,
): SecurityAuditEvent | undefined => {
  const path = ctx.path ?? "";
  const failure = outcome(ctx);
  const user = ctx.context.session?.user.id;
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
  if (method !== undefined) {
    const created = ctx.context.newSession?.user.id;
    if (created !== undefined)
      return { action: "sign_in", outcome: "success", user: created, detail: { method } };
    return failure === undefined
      ? undefined
      : event("sign_in", { user: undefined, detail: { method } });
  }
  if (otpChecks.has(path)) return failure === undefined ? undefined : event("otp.verify");
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
      return event("api_key.create", {
        target: { kind: "api_key", id: returned?.id },
        organization: returned?.metadata?.organization,
      });
    case "/api-key/delete":
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
      const query =
        failure === undefined ? Option.getOrUndefined(decodeOAuthQuery(ctx.body)) : undefined;
      const client =
        query === undefined
          ? undefined
          : (new URLSearchParams(query.oauth_query).get("client_id") ?? undefined);
      const accept = Option.getOrUndefined(decodeAccept(ctx.body))?.accept;
      return event("oauth.consent", {
        target: { kind: "oauth_client", id: Option.getOrUndefined(decodeId(client)) },
        detail: accept === undefined ? undefined : { decision: accept ? "allow" : "deny" },
      });
    }
    case "/admin/impersonate-user": {
      const started = failure === undefined ? ctx.context.newSession : undefined;
      return event("impersonation.start", {
        user: started?.session.impersonatedBy ?? user,
        target: { kind: "user", id: started?.user.id },
      });
    }
    case "/admin/stop-impersonating":
      return event("impersonation.stop", {
        user: failure === undefined ? (ctx.context.newSession?.user.id ?? user) : user,
        target: { kind: "user", id: failure === undefined ? impersonated : undefined },
      });
    default:
      return undefined;
  }
};

interface DeletedSession {
  readonly id: string;
  readonly userId: string;
}

export const authAudit = (
  record: (
    event: SecurityAuditEvent,
    session:
      | { readonly id: string; readonly user: string; readonly impersonatedBy?: string | undefined }
      | undefined,
  ) => Promise<void>,
): BetterAuthPlugin => {
  const confirmed = new WeakSet<object>();
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
