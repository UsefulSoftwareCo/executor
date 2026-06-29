import { useEffect, type ReactNode } from "react";
import { useNavigate, useParams } from "@tanstack/react-router";

// ---------------------------------------------------------------------------
// Org-slug URL canonicalization for org-scoped hosts (cloud, self-host,
// cloudflare). Console routes live under an optional `{-$orgSlug}` segment, so
// the same tree serves `/policies` and `/acme/policies`; this gate, mounted
// inside the authenticated shell, pins a BARE URL to the active org's slug:
//
//   - bare URL            → replace with `/<active-slug>/…` (canonicalize)
//   - slug already in URL → render
//
// The URL slug is the request SCOPE, not just a label: every API call carries
// it (the `x-executor-organization` header), and the server re-checks live
// membership and resolves data for that org — same as the MCP URL-pinned org.
// So a foreign slug never reaches this gate as "active": the server returns no
// organization for an org the caller can't see, and the shell 404s upstream.
// That makes two browser tabs on different orgs fully independent — no shared
// "active org" to steal.
// ---------------------------------------------------------------------------

export interface OrgSlugGateProps {
  /** The active organization's slug (from `useAuth().organization`). */
  readonly activeSlug: string;
  readonly children: ReactNode;
}

export function OrgSlugGate(props: OrgSlugGateProps) {
  const { activeSlug } = props;
  const params = useParams({ strict: false }) as { orgSlug?: string };
  const urlSlug = params.orgSlug ?? null;
  const navigate = useNavigate();

  // Only a BARE URL canonicalizes. A slug in the URL is the scope the whole
  // request chain already ran with, so it always matches `activeSlug` here.
  const needsCanonicalize = urlSlug === null;

  useEffect(() => {
    if (!needsCanonicalize) return;
    // Re-target the CURRENT route with the active slug. `to: "."` +
    // `search: true` keeps path and query (deep links like
    // `/integrations/add/mcp?url=…` canonicalize in place); only the orgSlug
    // param changes.
    void navigate({
      to: ".",
      params: (previous: Record<string, string>) => ({ ...previous, orgSlug: activeSlug }),
      search: true,
      replace: true,
    });
  }, [needsCanonicalize, activeSlug, navigate]);

  // Render through while canonicalizing — the target is the same route, so
  // withholding children would only flash the page.
  return <>{props.children}</>;
}
