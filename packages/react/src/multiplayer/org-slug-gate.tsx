import { useEffect, type ReactNode } from "react";
import { useNavigate, useParams, useRouterState } from "@tanstack/react-router";

// ---------------------------------------------------------------------------
// Org-slug URL canonicalization for org-scoped hosts (cloud, self-host,
// cloudflare). Console routes live under an optional `{-$orgSlug}` segment, so
// the same tree serves `/policies` and `/acme/policies`; this gate, mounted
// inside the authenticated shell, pins the URL to the active org's slug:
//
//   - bare URL                  → replace with `/<active-slug>/…` (canonicalize)
//   - active slug already in URL → render
//   - any other slug in URL     → replace with `/<active-slug>/…` (canonicalize)
//
// The URL slug is the request SCOPE, not just a label: every API call carries
// it (the `x-executor-organization` header), and the server re-checks live
// membership and resolves data for that org — same as the MCP URL-pinned org.
// So a foreign slug never reaches this gate as "active" on a multi-org host:
// the server returns no organization for an org the caller can't see, and the
// shell 404s upstream. That makes two browser tabs on different orgs fully
// independent — no shared "active org" to steal. On a single-org host (e.g.
// self-host) every slug resolves to the same org server-side, so a bogus slug
// (e.g. `/totally-bogus`) would otherwise fuzzy-match a route and render
// under the wrong URL forever; canonicalizing it here fixes the URL instead.
//
// A genuinely unmatched path is neither of the above: it has no `orgSlug`
// param (nothing below root matched) but isn't a bare URL either, so it must
// NOT canonicalize — doing so would silently rewrite a bad URL into a valid
// one instead of letting the not-found page render.
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

  // Skip canonicalization whenever the router is currently sitting on a
  // not-found match — see the file header for why.
  const isNotFound = useRouterState({
    select: (state) => state.matches.some((match) => match.globalNotFound),
  });

  const needsCanonicalize = urlSlug !== activeSlug && !isNotFound;

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
