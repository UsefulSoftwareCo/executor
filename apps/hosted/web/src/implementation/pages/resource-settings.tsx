/** Hosted access settings use the same persisted policy enforced by execution. */
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { Option } from "effect";
import type { AppId } from "@executor-js/sdk";
import { QueryView, usePreload } from "@executor-js/ui/dashboard/context";
import { DetailSkeleton } from "@executor-js/ui/dashboard/loading";
import { appAccessAtom, shareAppAtom } from "../../contracts/resource-access.ts";
import { sessionAtom } from "../../contracts/auth.ts";
import { groupsAtom } from "../../contracts/groups.ts";
import { HostedFailure } from "../components/dashboard-bindings.tsx";
import { useOrganizationRoute } from "../components/organization.tsx";
import { SharingEditor } from "../components/sharing.tsx";
/** These controls change app access; accounts and their links are separate. */
export function AppAccessSettings({ app }: { readonly app: AppId }) {
  const { organization } = useOrganizationRoute();
  const save = useAtomSet(shareAppAtom({ organization, app }), { mode: "promiseExit" });
  // The editor always needs the groups, so they load alongside the access rather than after it.
  usePreload(appAccessAtom({ organization, app }), groupsAtom(organization));
  const session = AsyncResult.value(useAtomValue(sessionAtom));
  const user = Option.isSome(session) ? session.value?.user.id : undefined;
  return (
    <section className="max-w-xl space-y-4">
      <h2 className="text-base font-medium">App access</h2>
      <QueryView
        query={appAccessAtom({ organization, app })}
        Failure={HostedFailure}
        pending={<DetailSkeleton label="Loading app access" />}
      >
        {(access) => (
          <QueryView
            query={groupsAtom(organization)}
            Failure={HostedFailure}
            pending={<DetailSkeleton label="Loading groups" />}
          >
            {(data) => (
              <SharingEditor
                disabledReason={
                  access.canManage
                    ? undefined
                    : "Only the app creator and organization admins can change app access."
                }
                value={access.audience}
                revision={access.revision}
                allowPrivate={access.creator !== null}
                privateLabel={access.creator === user ? "Only me" : "Only the creator"}
                groups={data.groups}
                save={(audience, revision) => save({ audience, revision })}
              />
            )}
          </QueryView>
        )}
      </QueryView>
    </section>
  );
}
