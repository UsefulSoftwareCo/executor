import { inventoryAtom } from "./organization.ts";
/** Personal setup metadata is acknowledged before navigation; catalogs key on saved revisions. */
import { Data, Effect } from "effect";
import { Atom } from "effect/unstable/reactivity";
import type { AppId, ProfileId, ProfileInputs, Profile } from "@executor-js/sdk";
import type { OrganizationReference } from "@executor-js/hosted-server/organization";
import { acknowledge, upsert, invalidate } from "@executor-js/ui/contracts/mutations";
import { pollingQuery } from "@executor-js/ui/contracts/polling";
import { HostedClient } from "./api.ts";
import { protectedQuery } from "./protected-query.ts";
import { acknowledgeResourceProfile } from "./resource-access.ts";
class AppKey extends Data.Class<{
  readonly organization: OrganizationReference;
  readonly app: AppId;
}> {}
class Target extends Data.Class<{
  readonly organization: OrganizationReference;
  readonly app: AppId;
  readonly profile: ProfileId;
}> {}
const source = Atom.family((key: AppKey) =>
  HostedClient.query("profiles", "list", { params: key }).pipe(
    Atom.refreshOnWindowFocus,
    protectedQuery,
  ),
);
const query = Atom.family((key: AppKey) => pollingQuery(source(key)));
/** Shared per-app metadata for the picker and setup form. */
export const profilesAtom = (key: { organization: OrganizationReference; app: AppId }) =>
  query(new AppKey({ organization: key.organization, app: key.app }));
/** Invalidate after account completion when only the saved account is returned. */
export const refreshProfiles = (
  get: Atom.FnContext,
  key: { organization: OrganizationReference; app: AppId },
) => invalidate(get, source(new AppKey({ organization: key.organization, app: key.app })));
const acknowledgeProfile = (get: Atom.FnContext, key: AppKey, saved: Profile) => {
  acknowledge(get, source(new AppKey({ organization: key.organization, app: key.app })), (rows) =>
    saved.status === "removed" ? rows.filter((row) => row.id !== saved.id) : upsert(rows, saved),
  );
  acknowledgeResourceProfile(get, key.organization, saved);
  acknowledge(get, inventoryAtom(key.organization), (data) => ({
    ...data,
    profiles:
      saved.status === "removed"
        ? data.profiles.filter((row) => row.id !== saved.id)
        : upsert(data.profiles, saved),
  }));
};
/** Stable operation identities prevent edits on one setup from cancelling another. */
export const profileMutations = (key: {
  organization: OrganizationReference;
  app: AppId;
  profile: ProfileId;
}) => mutations(new Target(key));
const mutations = Atom.family((key: Target) => ({
  setEnabled: HostedClient.runtime.fn(
    (input: Omit<typeof ProfileInputs.setEnabled.Type, "app" | "profile">, get) =>
      Effect.flatMap(HostedClient, (client) =>
        client.profiles.setEnabled({ params: key, payload: input }),
      ).pipe(Effect.tap((saved) => Effect.sync(() => acknowledgeProfile(get, key, saved)))),
  ),
  update: HostedClient.runtime.fn(
    (input: Omit<typeof ProfileInputs.update.Type, "app" | "profile">, get) =>
      Effect.flatMap(HostedClient, (client) =>
        client.profiles.update({ params: key, payload: input }),
      ).pipe(Effect.tap((saved) => Effect.sync(() => acknowledgeProfile(get, key, saved)))),
  ),
  reconcile: HostedClient.runtime.fn((_: void, get) =>
    Effect.flatMap(HostedClient, (client) => client.profiles.reconcile({ params: key })).pipe(
      Effect.tap((saved) => Effect.sync(() => acknowledgeProfile(get, key, saved))),
    ),
  ),
  remove: HostedClient.runtime.fn((_: void, get) =>
    Effect.flatMap(HostedClient, (client) => client.profiles.remove({ params: key })).pipe(
      Effect.tap((saved) => Effect.sync(() => acknowledgeProfile(get, key, saved))),
    ),
  ),
}));
/** The editor captures a revision once; a remote change must conflict instead of overwriting it. */
class SelectionKey extends Data.Class<{
  readonly organization: OrganizationReference;
  readonly app: AppId;
  readonly target:
    | { readonly kind: "new"; readonly request: string }
    | { readonly kind: "saved"; readonly id: ProfileId; readonly revision: number };
}> {}
const selection = Atom.family((key: SelectionKey) =>
  HostedClient.runtime.fn(
    (input: import("@executor-js/ui/contracts/dashboard").SelectAccounts, get) =>
      Effect.flatMap(HostedClient, (client) =>
        key.target.kind === "new"
          ? client.profiles.create({
              params: key,
              payload: {
                accounts: input.accounts,
                ...(input.name === undefined ? {} : { name: input.name }),
                idempotencyKey: key.target.request,
              },
            })
          : client.profiles.update({
              params: { ...key, profile: key.target.id },
              payload: { accounts: input.accounts, expectedRevision: key.target.revision },
            }),
      ).pipe(Effect.tap((saved) => Effect.sync(() => acknowledgeProfile(get, key, saved)))),
  ),
);
/** One save path for new and existing account selections. */
export const accountSelectionAtom = (key: ConstructorParameters<typeof SelectionKey>[0]) =>
  selection(new SelectionKey(key));

const hooksSource = Atom.family((key: Target) =>
  HostedClient.query("webhooks", "list", {
    params: key,
    query: { profile: key.profile },
  }).pipe(Atom.refreshOnWindowFocus),
);
const hooks = Atom.family((key: Target) => pollingQuery(hooksSource(key)));
/** Lifecycle metadata never includes signing secrets. */
export const profileWebhooksAtom = (key: ConstructorParameters<typeof Target>[0]) =>
  hooks(new Target(key));
