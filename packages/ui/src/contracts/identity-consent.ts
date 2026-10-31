/** The browser proposes visible targets; each host creates and authorizes its own saved request. */
import type {
  AccountId,
  AccountScope,
  AppId,
  OAuthConnectionPlan,
  OAuthGrantReuseResult,
  Provider,
} from "@executor-js/sdk";
import type { Exit } from "effect";
import type { Inventory } from "./dashboard.ts";

export interface IdentityAppTarget {
  readonly app: AppId;
  readonly requirement: string;
  readonly scope: AccountScope;
  readonly method: string;
}
export interface IdentityConsentSelection {
  readonly sourceAccount?: AccountId | null | undefined;
  readonly additionalTargets?: readonly IdentityAppTarget[] | undefined;
}
export interface IdentityConsentBindings<E> {
  readonly plan: (
    input: IdentityConsentSelection & { readonly method: string },
  ) => Promise<Exit.Exit<OAuthConnectionPlan, E>>;
  readonly reuse: (
    input: IdentityConsentSelection & {
      readonly method: string;
      readonly sourceAccount: AccountId;
    },
  ) => Promise<Exit.Exit<typeof OAuthGrantReuseResult.Type, E>>;
}

export const identityAppTargets = (inventory: Inventory, issuer: string, exclude?: AppId) =>
  inventory.apps.flatMap((app) =>
    app.id === exclude
      ? []
      : Object.entries(app.requirements.accounts).flatMap(([requirement, target]) => {
          const methods = Object.entries(target.definition.auth).filter(
            ([, method]) =>
              method.type === "oauth2" &&
              method.grant !== "client_credentials" &&
              method.identity?.issuer === issuer,
          );
          const method = methods[0]?.[0];
          return method === undefined ? [] : [{ app, requirement, target, method }];
        }),
  );
export const identityMethod = (provider: Provider, method: string) => {
  const auth = provider.definition.auth[method];
  return auth?.type === "oauth2" && auth.grant !== "client_credentials" ? auth.identity : undefined;
};
