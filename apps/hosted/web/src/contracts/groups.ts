/** Organization-scoped group reads and confirmed mutations share one reconciled view. */
import { Atom } from "effect/unstable/reactivity";
import { Effect } from "effect";
import type { OrganizationReference } from "@executor-js/hosted-server/organization";
import type { Group, GroupInput, GroupId } from "@executor-js/hosted-server/groups";
import { acknowledge, acknowledgedQuery, upsert } from "@executor-js/ui/contracts/mutations";
import { HostedClient } from "./api.ts";

/** Keep confirmed groups visible while background reconciliation runs. */
export const groupsAtom = Atom.family((organization: OrganizationReference) =>
  HostedClient.query("groups", "list", { params: { organization } }).pipe(
    Atom.refreshOnWindowFocus,
    acknowledgedQuery,
  ),
);
type Save = {
  readonly input: typeof GroupInput.Type;
  readonly existing: Pick<Group, "id" | "revision"> | null;
};
/** An edit submits its original revision; failed writes never replace local drafts. */
export const saveGroupAtom = Atom.family((organization: OrganizationReference) =>
  HostedClient.runtime.fn((input: Save, get) =>
    Effect.flatMap(HostedClient, (client) =>
      input.existing === null
        ? client.groups.create({ params: { organization }, payload: input.input })
        : client.groups.update({
            params: { organization, group: input.existing.id },
            payload: { ...input.input, revision: input.existing.revision },
          }),
    ).pipe(
      Effect.tap((saved) =>
        Effect.sync(() =>
          acknowledge(get, groupsAtom(organization), (current) => ({
            ...current,
            groups: upsert(current.groups, saved),
          })),
        ),
      ),
    ),
  ),
);
/** Delete only the reviewed revision and remove its row after server confirmation. */
export const removeGroupAtom = Atom.family((organization: OrganizationReference) =>
  HostedClient.runtime.fn((group: Pick<Group, "id" | "revision">, get) =>
    Effect.flatMap(HostedClient, (client) =>
      client.groups.remove({
        params: { organization, group: group.id },
        payload: { revision: group.revision },
      }),
    ).pipe(
      Effect.tap((removed: { readonly id: GroupId }) =>
        Effect.sync(() =>
          acknowledge(get, groupsAtom(organization), (current) => ({
            ...current,
            groups: current.groups.filter((item) => item.id !== removed.id),
          })),
        ),
      ),
    ),
  ),
);
