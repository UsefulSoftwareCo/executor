/** Personal setup metadata is acknowledged before navigation; catalogs key on saved revisions. */
import { hydrated } from "@executor-js/ui/contracts/http";
import { revalidated } from "@executor-js/ui/contracts/refresh";
import { Data, Effect } from "effect";
import { Atom } from "effect/reactivity";
import type { AppId, ProfileId, ProfileInputs, Profile } from "@executor-js/sdk";
import { acknowledge, upsert } from "@executor-js/ui/contracts/mutations";
import { pollingQuery, steadyPolling } from "@executor-js/ui/contracts/polling";
import { DashboardClient, overviewAtom } from "./api.ts";
import { acknowledgedQuery } from "@executor-js/ui/contracts/mutations";
class AppKey extends Data.Class<{ readonly app: AppId }> {}
class Target extends Data.Class<{ readonly app: AppId; readonly profile: ProfileId }> {}
const source = Atom.family((key: AppKey) =>
  DashboardClient.query("profiles", "list", hydrated({ params: key })).pipe(
    revalidated,
    acknowledgedQuery,
  ),
);
const query = Atom.family((key: AppKey) => pollingQuery(source(key), steadyPolling));
/** Shared per-app metadata for the picker and setup form. */
export const profilesAtom = (key: { app: AppId }) => query(new AppKey({ app: key.app }));
const acknowledgeProfile = (get: Atom.FnContext, key: { readonly app: AppId }, saved: Profile) => {
  const merge = (rows: readonly Profile[]) =>
    saved.status === "removed" ? rows.filter((row) => row.id !== saved.id) : upsert(rows, saved);
  acknowledge(get, source(new AppKey({ app: key.app })), merge);
  acknowledge(get, overviewAtom, (data) => ({ ...data, profiles: merge(data.profiles) }));
};
/** A completed app connection changed a profile's selection on the server; read it again. */
export const profileSelectionChanged = (get: Atom.FnContext | Atom.AtomContext, app: AppId) => {
  get.registry.refresh(source(new AppKey({ app })));
  get.registry.refresh(overviewAtom);
};
/** Create a profile once for an app connection; retries with the same key return it. */
export const createProfile = (
  get: Atom.FnContext,
  key: {
    readonly app: AppId;
    readonly accounts: import("@executor-js/sdk").SelectedAccounts;
    readonly idempotencyKey: string;
  },
) =>
  Effect.flatMap(DashboardClient, (client) =>
    client.profiles.create({
      params: { app: key.app },
      payload: { accounts: key.accounts, idempotencyKey: key.idempotencyKey },
    }),
  ).pipe(Effect.tap((saved) => Effect.sync(() => acknowledgeProfile(get, key, saved))));
/** Stable operation identities prevent edits on one setup from cancelling another. */
export const profileMutations = (key: { app: AppId; profile: ProfileId }) =>
  mutations(new Target(key));
const mutations = Atom.family((key: Target) => ({
  setEnabled: DashboardClient.runtime.fn(
    (input: Omit<typeof ProfileInputs.setEnabled.Type, "app" | "profile">, get) =>
      Effect.flatMap(DashboardClient, (client) =>
        client.profiles.setEnabled({ params: key, payload: input }),
      ).pipe(Effect.tap((saved) => Effect.sync(() => acknowledgeProfile(get, key, saved)))),
  ),
  update: DashboardClient.runtime.fn(
    (input: Omit<typeof ProfileInputs.update.Type, "app" | "profile">, get) =>
      Effect.flatMap(DashboardClient, (client) =>
        client.profiles.update({ params: key, payload: input }),
      ).pipe(Effect.tap((saved) => Effect.sync(() => acknowledgeProfile(get, key, saved)))),
  ),
  reconcile: DashboardClient.runtime.fn((_: void, get) =>
    Effect.flatMap(DashboardClient, (client) => client.profiles.reconcile({ params: key })).pipe(
      Effect.tap((saved) => Effect.sync(() => acknowledgeProfile(get, key, saved))),
    ),
  ),
  remove: DashboardClient.runtime.fn((_: void, get) =>
    Effect.flatMap(DashboardClient, (client) => client.profiles.remove({ params: key })).pipe(
      Effect.tap((saved) => Effect.sync(() => acknowledgeProfile(get, key, saved))),
    ),
  ),
}));
/** The editor captures a revision once; a remote change must conflict instead of overwriting it. */
class SelectionKey extends Data.Class<{
  readonly app: AppId;
  readonly target:
    | { readonly kind: "new"; readonly request: string }
    | { readonly kind: "saved"; readonly id: ProfileId; readonly revision: number };
}> {}
const selection = Atom.family((key: SelectionKey) =>
  DashboardClient.runtime.fn(
    (input: import("@executor-js/ui/contracts/dashboard").SelectAccounts, get) =>
      Effect.flatMap(DashboardClient, (client) =>
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
  DashboardClient.query("profiles", "webhooks", hydrated({ params: key })).pipe(revalidated),
);
const hooks = Atom.family((key: Target) => pollingQuery(hooksSource(key), steadyPolling));
/** Lifecycle metadata never includes signing secrets. */
export const profileWebhooksAtom = (key: ConstructorParameters<typeof Target>[0]) =>
  hooks(new Target(key));
