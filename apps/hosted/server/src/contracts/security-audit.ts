/**
 * Security audit events: one log record named `security.audit` for each security-relevant action,
 * with who did it, from where, to what and whether it succeeded. They are telemetry, delivered
 * best effort like every other log, not a durable audit trail.
 */
import { Schema } from "effect";

/** What happened. The vocabulary is closed so that a query can name every action. */
export const SecurityAuditAction = Schema.Literals([
  "sign_in",
  "impersonation.start",
  "impersonation.stop",
  "otp.verify",
  "session.revoke",
  "api_key.create",
  "api_key.delete",
  "member.role_change",
  "member.remove",
  "invitation.create",
  "invitation.accept",
  "invitation.cancel",
  "oauth_client.register",
  "oauth.consent",
  "provider_oauth_client.create",
  "provider_oauth_client.delete",
  "mcp_agent.revoke",
  "mcp_connection.revoke",
  "organization.delete",
  "user.delete",
  "credential.read",
]);
export type SecurityAuditAction = typeof SecurityAuditAction.Type;

/**
 * How an action ended:
 *
 * - `success`: the change it makes was stored, or the read it audits happened.
 * - `failure`: it was refused or failed before changing anything it audits.
 * - `interrupted`: the request ended before the action's outcome was known; a change it started
 *   may still have been stored.
 * - `unconfirmed`: the action answered success, but the change it reports was not observed where
 *   it is stored, such as a sign-out whose session deletion failed or found nothing to delete.
 */
export type SecurityAuditOutcome = "success" | "failure" | "interrupted" | "unconfirmed";

const AuditFailureCode = Schema.String.pipe(Schema.brand("SecurityAuditFailure"));
/** A failure code from a recorder's closed set, or `other`; made only by `auditFailureCodes`. */
export type SecurityAuditFailure = typeof AuditFailureCode.Type;

/**
 * The failure codes a recorder may write: each of `codes`, and `other` for any code outside them.
 * A failure code can come from a request or a redirect a client wrote, so it is never recorded
 * unless it is one of the codes the recorder knows its endpoints answer with.
 */
export const auditFailureCodes = (codes: Iterable<string>) => {
  const known = new Set(codes);
  return (code: string | undefined): SecurityAuditFailure | undefined =>
    code === undefined ? undefined : AuditFailureCode.make(known.has(code) ? code : "other");
};

/**
 * One audited action. Every value is an opaque ID, a closed label or a known error code; never a
 * credential, an email address, a name or a request body. A target's ID, the user and the
 * organization come only from stored records the action was authorized against, or from what it
 * stored, never from what the request asked for: an ID a caller sends can be any text. The
 * caller's user and organization default to the request's verified caller and membership.
 */
export interface SecurityAuditEvent {
  readonly action: SecurityAuditAction;
  readonly outcome: SecurityAuditOutcome;
  /** The kind and opaque ID of what the action applied to, such as `api_key` and the key's ID. */
  readonly target?: { readonly kind: string; readonly id?: string | undefined } | undefined;
  /** A known error code for a failure, such as Better Auth's `INVALID_OTP`. */
  readonly failure?: SecurityAuditFailure | undefined;
  /** How, from a closed set: a sign-in's method, a credential read's purpose, a new role. */
  readonly detail?: Readonly<Record<string, string>> | undefined;
  readonly user?: string | undefined;
  /** An organization the caller's membership, or the stored change, places the action in. */
  readonly organization?: string | undefined;
}
