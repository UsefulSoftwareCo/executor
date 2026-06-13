import { useEffect, useRef, useState, type ReactNode } from "react";
import { useAtomValue, useAtomSet } from "@effect/atom-react";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import * as Exit from "effect/Exit";
import { authWriteKeys } from "@executor-js/react/api/reactivity-keys";
import { OrgSlugNotFound } from "@executor-js/react/multiplayer/org-slug-gate";

import { organizationsAtom, switchOrganization } from "../auth";

// ---------------------------------------------------------------------------
// Foreign-slug resolution for the cloud org-slug gate: the URL names a slug
// that isn't the active org's. Resolve it against the caller's memberships:
//   - a member of that org (their bookmark, a teammate's shared link) → switch
//     the session into it and reload, so every atom re-scopes
//   - anything else → a WRONG ADDRESS → not-found. A slug must never silently
//     resolve to a different workspace than the URL names, and single-segment
//     typos (/this-page-does-not-exist) match the slugged index route, so this
//     IS the app's 404 for them.
// Membership comes from the already-cached organizations atom; the matched
// case alone performs a side effect, isolated in `SwitchIntoOrg`.
// ---------------------------------------------------------------------------

const Centered = (props: { children?: ReactNode }) => (
  <div className="flex min-h-full flex-1 items-center justify-center text-sm text-muted-foreground">
    {props.children}
  </div>
);

// Switch the session into `organizationId`, then full-reload so the whole app
// re-scopes. One-shot: the ref guards React's double-invoke and the render
// between resolution and the reload landing. A failed switch means the slug
// named an org we can't actually enter — fall back to not-found.
function SwitchIntoOrg(props: { readonly organizationId: string }) {
  const doSwitchOrganization = useAtomSet(switchOrganization, { mode: "promiseExit" });
  const [failed, setFailed] = useState(false);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void doSwitchOrganization({
      payload: { organizationId: props.organizationId },
      reactivityKeys: authWriteKeys,
    }).then((exit) => (Exit.isSuccess(exit) ? window.location.reload() : setFailed(true)));
  }, [props.organizationId, doSwitchOrganization]);

  return failed ? <OrgSlugNotFound /> : <Centered>Switching organization…</Centered>;
}

export function ForeignOrgSlug(props: { readonly slug: string }) {
  const organizations = useAtomValue(organizationsAtom);

  return AsyncResult.match(organizations, {
    onInitial: () => <Centered />,
    onFailure: () => <OrgSlugNotFound />,
    onSuccess: ({ value }) => {
      const match = value.organizations.find((org: { slug: string }) => org.slug === props.slug);
      return match ? <SwitchIntoOrg organizationId={match.id} /> : <OrgSlugNotFound />;
    },
  });
}
