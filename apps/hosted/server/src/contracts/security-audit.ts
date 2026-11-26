import { Schema } from "effect";

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

export type SecurityAuditOutcome = "success" | "failure" | "interrupted" | "unconfirmed";

const AuditFailureCode = Schema.String.pipe(Schema.brand("SecurityAuditFailure"));
export type SecurityAuditFailure = typeof AuditFailureCode.Type;

export const auditFailureCodes = (codes: Iterable<string>) => {
  const known = new Set(codes);
  return (code: string | undefined): SecurityAuditFailure | undefined =>
    code === undefined ? undefined : AuditFailureCode.make(known.has(code) ? code : "other");
};

export interface SecurityAuditEvent {
  readonly action: SecurityAuditAction;
  readonly outcome: SecurityAuditOutcome;
  readonly target?: { readonly kind: string; readonly id?: string | undefined } | undefined;
  readonly failure?: SecurityAuditFailure | undefined;
  readonly detail?: Readonly<Record<string, string>> | undefined;
  readonly user?: string | undefined;
  readonly organization?: string | undefined;
}
