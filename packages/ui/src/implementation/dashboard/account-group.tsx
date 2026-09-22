import type { App, Profile, ProfileId } from "@executor-js/sdk";

/** Setup names label an exact profile; account bindings never define its identity. */
export interface AccountContext {
  readonly key: string;
  readonly label: string;
  readonly app: App;
  readonly profile: Profile | undefined;
}

/** App-owned execution remains available when every provider is fixed, including zero providers. */
export function accountContexts(
  app: App,
  profiles: readonly Profile[],
  includeDisabled = false,
): readonly AccountContext[] {
  const entries: AccountContext[] = profiles
    .filter(
      (item) =>
        item.status !== "removed" &&
        (includeDisabled || (item.enabled && item.status !== "removing")),
    )
    .map((profile) => ({
      key: profile.id,
      label:
        profile.name ??
        (profiles.indexOf(profile) === 0 ? "Default" : `Profile ${profiles.indexOf(profile) + 1}`),
      app: { ...app, accounts: { ...app.accounts, ...profile.accounts } },
      profile,
    }));
  if (Object.keys(app.requirements.accounts).every((slot) => Object.hasOwn(app.accounts, slot))) {
    entries.unshift({ key: "app", label: "App", app, profile: undefined });
  }
  return entries;
}

/** Explicit URLs never fall back to a different profile; an unselected page prefers an enabled one. */
export function selectedAccountContext(
  contexts: readonly AccountContext[],
  profile: ProfileId | undefined,
): AccountContext | undefined {
  if (profile !== undefined) return contexts.find((context) => context.profile?.id === profile);
  return (
    contexts.find(
      (context) =>
        context.profile === undefined ||
        (context.profile.enabled && context.profile.status !== "removing"),
    ) ?? contexts[0]
  );
}
