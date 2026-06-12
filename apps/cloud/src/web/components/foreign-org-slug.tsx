import { useEffect, useRef } from "react";
import { useAtomValue, useAtomSet } from "@effect/atom-react";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import * as Exit from "effect/Exit";
import { authWriteKeys } from "@executor-js/react/api/reactivity-keys";
import { OrgSlugNotFound } from "@executor-js/react/multiplayer/org-slug-gate";

import { organizationsAtom, switchOrganization } from "../auth";

// ---------------------------------------------------------------------------
// Foreign-slug resolution for the cloud org-slug gate: the URL carries a slug
// that isn't the active org's. If the caller is a member of that org (their
// bookmark, a teammate's link into a shared org), switch the session to it
// and reload so the whole app re-scopes. Anything else is a WRONG ADDRESS and
// renders not-found — a slug must never silently resolve to a different
// workspace than the URL names, and single-segment typos (/this-page-does-
// not-exist) match the slugged index route, so this page IS the app's 404 for
// them. Membership comes from the already-cached organizations atom; the
// fallback while it loads is a blank screen, not a skeleton.
// ---------------------------------------------------------------------------

export function ForeignOrgSlug(props: { readonly slug: string }) {
  const organizations = useAtomValue(organizationsAtom);
  const doSwitchOrganization = useAtomSet(switchOrganization, { mode: "promiseExit" });
  const switching = useRef(false);

  const target = AsyncResult.match(organizations, {
    onInitial: () => null,
    onFailure: () => "none" as const,
    onSuccess: ({ value }) =>
      value.organizations.find((org: { slug: string }) => org.slug === props.slug) ??
      ("none" as const),
  });

  const targetOrgId = target !== null && target !== "none" ? target.id : null;

  useEffect(() => {
    if (!targetOrgId || switching.current) return;
    switching.current = true;
    void doSwitchOrganization({
      payload: { organizationId: targetOrgId },
      reactivityKeys: authWriteKeys,
    }).then((exit) => {
      // Keep the URL (it already names the target org); reload re-scopes the
      // app to the switched session. On failure fall through to not-found by
      // releasing the guard — the next render still has no active match.
      if (Exit.isSuccess(exit)) {
        window.location.reload();
      } else {
        switching.current = false;
      }
    });
  }, [targetOrgId, doSwitchOrganization]);

  if (target === "none") return <OrgSlugNotFound />;

  return (
    <div className="flex min-h-screen items-center justify-center text-sm text-muted-foreground">
      {targetOrgId ? "Switching organization…" : ""}
    </div>
  );
}
