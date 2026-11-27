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
import type { AccountId, AppId, VersionId } from "../contracts/shared.ts";
import type { ToolInvocation } from "../contracts/tools.ts";

export interface LinkedRequirement<A extends AccountChoice = AccountChoice> {
  readonly cardinality: AccountRequirement["cardinality"];
  readonly accounts: readonly A[];
}
export type LinkedAccounts<A extends AccountChoice = AccountChoice> = Readonly<
  Record<string, LinkedRequirement<A>>
>;

export interface RequirementLink<A> {
  readonly requirement: string;
  readonly account: A;
}

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

export const plainAccount = <A>(accounts: readonly A[]): A | undefined => accounts.at(-1);

const resolveScope = (
  app: AppId,
  version: VersionId,
  scope: AccountScope,
  requirements: LinkedAccounts,
  connecting?: string,
): Effect.Effect<Record<string, ReadonlyArray<AccountId>>, AccountRequired> =>
  Effect.gen(function* () {
    const resolved: Record<string, ReadonlyArray<AccountId>> = {};
    for (const [slot, requirement] of Object.entries(requirements)) {
      if (requirement.cardinality === "many") {
        resolved[slot] = requirement.accounts.map((account) => account.id);
        continue;
      }
      const account = plainAccount(requirement.accounts);
      if (account === undefined && connecting !== undefined) continue;
      if (account === undefined) return yield* new AccountRequired({ app, version, slot, scope });
      resolved[slot] = [account.id];
    }
    return resolved;
  });

export const resolveLinkedAccounts = (input: {
  readonly app: AppId;
  readonly version: VersionId | null;
  readonly appLinks: LinkedAccounts;
  readonly userLinks: LinkedAccounts;
  readonly connecting?: string;
}) =>
  Effect.gen(function* () {
    if (Object.keys(input.appLinks).length === 0 && Object.keys(input.userLinks).length === 0)
      return { app: {}, user: {} } satisfies AppAccounts;
    const version = input.version;
    if (version === null) return yield* new AppNotDeployed({ app: input.app });
    return {
      app: yield* resolveScope(input.app, version, "app", input.appLinks, input.connecting),
      user: yield* resolveScope(input.app, version, "user", input.userLinks, input.connecting),
    } satisfies AppAccounts;
  });

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
