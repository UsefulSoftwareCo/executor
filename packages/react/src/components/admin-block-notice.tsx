import {
  ADMIN_BLOCK_NEXT_STEP,
  ADMIN_BLOCK_TITLE,
  adminBlockReference,
  type OAuthAdminBlock,
} from "../plugins/oauth-admin-block";

// ---------------------------------------------------------------------------
// The blocked-by-administrator notice.
//
// Presented as an ORGANIZATION DECISION, not an error the user can work
// around: no retry, no alternative sign-in, no "try again" — every one of those
// would offer the route the identity provider just closed. What it does give is
// the provider's own code, so a member can quote it to whoever administers the
// policy.
//
// Grayscale, per design.md: destructive red is for irreversible actions and
// faults, and this is neither. It is a policy outcome.
// ---------------------------------------------------------------------------

export function AdminBlockNotice(props: {
  readonly block: OAuthAdminBlock;
  readonly className?: string;
}) {
  const reference = adminBlockReference(props.block);
  return (
    <div
      role="alert"
      data-slot="admin-block-notice"
      className={`space-y-1 rounded-lg border border-border bg-muted/40 p-3 ${props.className ?? ""}`}
    >
      <p className="text-sm font-medium text-foreground">{ADMIN_BLOCK_TITLE}</p>
      <p className="text-xs text-muted-foreground">{props.block.message}</p>
      <p className="text-xs text-muted-foreground">{ADMIN_BLOCK_NEXT_STEP}</p>
      {reference === null ? null : (
        <p className="font-mono text-[11px] text-muted-foreground">{reference}</p>
      )}
    </div>
  );
}
