/**
 * The accounts an operation a caller starts runs with, from the accounts the caller linked to the
 * app. Products decide which accounts are linked and usable; these rules decide nothing about
 * access. Calls never choose accounts.
 */
import { Effect } from "effect";
import {
  AccountRequired,
  AppNotDeployed,
  type AccountChoice,
  type AccountRequirement,
  type AccountScope,
  type AppAccounts,
  type AppRequirements,
} from "../contracts/apps.ts";
import type { AccountId, AppId, DeploymentId } from "../contracts/shared.ts";
import type { ToolInvocation } from "../contracts/tools.ts";

/** One requirement's cardinality and the caller's linked accounts for it, oldest link first. */
export interface LinkedRequirement<A extends AccountChoice = AccountChoice> {
  readonly cardinality: AccountRequirement["cardinality"];
  readonly accounts: readonly A[];
}
/** Every requirement of an app, with the caller's linked accounts for each. */
export type LinkedAccounts<A extends AccountChoice = AccountChoice> = Readonly<
  Record<string, LinkedRequirement<A>>
>;

/** One account linked to a requirement: an app link or a caller's user link. */
export interface RequirementLink<A> {
  readonly requirement: string;
  readonly account: A;
}

/**
 * Group one scope's links by the requirement each names, keeping their order, oldest first. A link
 * names its requirement; one whose requirement is not a requirement of this scope in the deployment
 * is left out, so an app requirement is filled only by app links and a user requirement only by the
 * caller's user links, even when they share a provider or an account.
 */
export const linkedRequirements = <A extends AccountChoice>(
  requirements: AppRequirements["accounts"],
  scope: AccountScope,
  links: ReadonlyArray<RequirementLink<A>>,
): LinkedAccounts<A> =>
  Object.fromEntries(
    Object.entries(requirements)
      .filter(([, required]) => required.scope === scope)
      .map(([slot, required]) => [
        slot,
        {
          cardinality: required.cardinality,
          accounts: links.filter((link) => link.requirement === slot).map((link) => link.account),
        },
      ]),
  );

/**
 * The account a plain requirement uses: its newest link. Linking another account replaces the one
 * before, so a plain requirement has at most one, unless a deploy turned a many() requirement into
 * a plain one while several were linked.
 */
export const plainAccount = <A>(accounts: readonly A[]): A | undefined => accounts.at(-1);

/** One scope's requirements resolved: plain ones to their account, many() to every one. */
const resolveScope = (
  app: AppId,
  deployment: DeploymentId,
  scope: AccountScope,
  requirements: LinkedAccounts,
): Effect.Effect<Record<string, ReadonlyArray<AccountId>>, AccountRequired> =>
  Effect.gen(function* () {
    const resolved: Record<string, ReadonlyArray<AccountId>> = {};
    for (const [slot, requirement] of Object.entries(requirements)) {
      if (requirement.cardinality === "many") {
        resolved[slot] = requirement.accounts.map((account) => account.id);
        continue;
      }
      const account = plainAccount(requirement.accounts);
      if (account === undefined)
        return yield* new AccountRequired({ app, deployment, slot, scope });
      resolved[slot] = [account.id];
    }
    return resolved;
  });

/**
 * Resolve every requirement of the deployment for one call: app requirements from the app links,
 * user requirements from the caller's user links (see {@link linkedRequirements}). A plain
 * requirement uses its account (see {@link plainAccount}); with none it fails with
 * `AccountRequired`. many() uses every account. An app with requirements and no active deployment
 * fails with `AppNotDeployed`.
 */
export const resolveLinkedAccounts = (input: {
  readonly app: AppId;
  readonly deployment: DeploymentId | null;
  readonly appLinks: LinkedAccounts;
  readonly userLinks: LinkedAccounts;
}) =>
  Effect.gen(function* () {
    if (Object.keys(input.appLinks).length === 0 && Object.keys(input.userLinks).length === 0)
      return { app: {}, user: {} } satisfies AppAccounts;
    const deployment = input.deployment;
    if (deployment === null) return yield* new AppNotDeployed({ app: input.app });
    return {
      app: yield* resolveScope(input.app, deployment, "app", input.appLinks),
      user: yield* resolveScope(input.app, deployment, "user", input.userLinks),
    } satisfies AppAccounts;
  });

/**
 * A reviewed invocation's account identities as the accounts it names, by scope. A call without a
 * caller names no `user`.
 */
export const invocationAccounts = (invocation: Pick<ToolInvocation, "accounts">): AppAccounts => {
  const ids = (slots: ToolInvocation["accounts"]["app"]) =>
    Object.fromEntries(
      Object.entries(slots).map(([slot, selected]) => [
        slot,
        "id" in selected ? [selected.id] : selected.map((account) => account.id),
      ]),
    );
  const user = invocation.accounts.user;
  return user === undefined
    ? { app: ids(invocation.accounts.app) }
    : { app: ids(invocation.accounts.app), user: ids(user) };
};
