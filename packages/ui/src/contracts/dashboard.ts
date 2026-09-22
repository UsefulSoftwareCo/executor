/** Display contracts shared by dashboards. Hosts retain ownership, auth, and transport semantics. */
import type {
  Account,
  AccountId,
  App,
  AppId,
  ProfileId,
  Deployment,
  DeploymentId,
  Provider,
  ProviderDefinition,
  SelectedAccounts,
} from "@executor-js/sdk";
import type { McpImportAuth } from "@executor-js/catalog/contracts";
import type { Atom, AsyncResult } from "effect/unstable/reactivity";
import { Schema, type Cause } from "effect";
import type { ComponentType, ReactNode } from "react";

/** Display metadata may be absent in a host that has not exposed provider/status details yet. */
export type AccountSummary = Account & {
  readonly providerName?: string;
  readonly providerUrl?: string | null;
  readonly signIn?:
    | { readonly state: "saved"; readonly reconnectAt: Date | null }
    | { readonly state: "reconnect" | "unavailable" };
};
/** Safe account detail shared by hosts; management authority remains product-owned. */
export interface AccountDetail {
  readonly account: AccountSummary;
  readonly provider: Provider;
  readonly apps: readonly App[];
  readonly canManage: boolean;
}
/** The common inventory contains no product permission or organization fields. */
export interface Inventory {
  readonly apps: readonly App[];
  readonly accounts: readonly AccountSummary[];
}
/** Any Effect Atom source, including a live stream or a one-shot HTTP query. */
export type Query<A, E> = Atom.Atom<AsyncResult.AsyncResult<A, E>>;
/** The atom determines E; its failure renderer must handle that complete error union. */
export interface QueryProps<A, E> {
  readonly query: Query<A, E>;
  readonly Failure: ComponentType<FailureProps<NoInfer<E>>>;
}
/** Deployment history and retained source supplied by a product-specific dashboard adapter. */
export interface AppDeploymentsProps<E> {
  readonly app: App;
  readonly deployments: readonly {
    readonly id: DeploymentId;
    readonly createdAt: Date;
    readonly fileCount: number;
  }[];
  readonly deployment: DeploymentId;
  readonly onDeploymentChange: (deployment: DeploymentId | undefined) => void;
  readonly query: Query<Deployment, E>;
  readonly Failure: ComponentType<FailureProps<NoInfer<E>>>;
  readonly actions?: ReactNode;
}
/** Common command input; a host adapter supplies its own API route parameters. */
export interface InstallApp {
  readonly entry: string;
  readonly name: string;
  readonly mcpAuth?: McpImportAuth;
}
/** A typed command and its operation-specific failure renderer. */
export interface MutationProps<Input, A, E> {
  readonly mutation: Atom.AtomResultFn<Input, A, E>;
  readonly Failure: ComponentType<FailureProps<NoInfer<E>>>;
}
/** Saved account selection supplied to a product resolver. */
/** Name is used only when creating an additional setup. */
export interface SelectAccounts {
  readonly name?: string;
  readonly app: AppId;
  readonly accounts: SelectedAccounts;
}
/** App sections use one URL vocabulary across local and hosted dashboards. */
export const AppView = Schema.Literals([
  "overview",
  "schedules",
  "skills",
  "workflows",
  "webhooks",
  "tools",
  "accounts",
  "source",
  "history",
  "deployments",
  "settings",
]);
export type AppView = typeof AppView.Type;
/** Host routing remains typed by that host's TanStack tree. */
export interface AppLinkProps {
  readonly app: AppId;
  readonly view?: AppView;
  readonly tool?: string;
  readonly profile?: ProfileId | undefined;
  readonly className?: string;
  readonly children: ReactNode;
  readonly "aria-label"?: string;
  readonly "aria-current"?: "page" | undefined;
}
/** Accounts without a detail route can still render their label. */
export interface AccountLinkProps {
  readonly account: AccountId;
  readonly children: ReactNode;
}
/** Expected failures are formatted by the product without leaking transport data. */
export interface FailureProps<E> {
  readonly cause: Cause.Cause<E>;
  readonly retry?: (() => void) | undefined;
}
/** Only error-independent presentation belongs in context. Queries keep their own error types. */
export interface DashboardBindings {
  readonly iconDomains: Atom.Atom<ReadonlyMap<string, string | null>>;
  readonly AppLink: ComponentType<AppLinkProps>;
  readonly AccountLink: ComponentType<AccountLinkProps>;
}

/** Resolve selected identities without inferring account ownership or permission. */
export const selectedIds = (app: App): readonly AccountId[] => [
  ...new Set(
    Object.values(app.accounts).flatMap((value) => (typeof value === "string" ? [value] : value)),
  ),
];
/** Display saved account identities without mistaking an empty label for unavailable account metadata. */
export const selectedAccountLabels = (app: App, accounts: readonly AccountSummary[]) =>
  selectedIds(app).map((id) => {
    const account = accounts.find((item) => item.id === id);
    return {
      id,
      label: account === undefined ? "Account unavailable" : account.label || "Unnamed account",
    };
  });
/** Token expiry needs user action only when the host cannot refresh it. */
export const accountNeedsSignIn = (account: AccountSummary, now = Date.now()) =>
  account.signIn?.state === "reconnect" ||
  (account.signIn?.state === "saved" &&
    account.signIn.reconnectAt !== null &&
    account.signIn.reconnectAt.getTime() <= now);
/** A selection problem that prevents this app from running. */
export interface AccountSelectionIssue {
  readonly slot: string;
  readonly reason: "missing" | "disconnected" | "incompatible";
}
/** Check saved selections against available metadata, without asserting upstream access. */
export function accountSelectionIssues(
  app: App,
  accounts: readonly AccountSummary[],
): readonly AccountSelectionIssue[] {
  return Object.entries(app.requirements.accounts).flatMap(
    ([slot, requirement]): AccountSelectionIssue[] => {
      const selection = app.accounts[slot];
      if (selection === undefined) return [{ slot, reason: "missing" }];
      const ids = typeof selection === "string" ? [selection] : selection;
      if (ids.some((id) => !accounts.some((account) => account.id === id)))
        return [{ slot, reason: "disconnected" }];
      if (
        (requirement.cardinality === "one") !== (typeof selection === "string") ||
        ids.some(
          (id) =>
            !accounts.some(
              (account) => account.id === id && account.provider === requirement.provider,
            ),
        )
      )
        return [{ slot, reason: "incompatible" }];
      return [];
    },
  );
}
/** Account metadata can block tool discovery; missing credential-health metadata makes no claim. */
export function appToolReadiness<A extends AccountSummary>(
  app: App,
  accounts: readonly A[],
):
  | { readonly state: "not-deployed" }
  | { readonly state: "selection"; readonly issues: readonly AccountSelectionIssue[] }
  | { readonly state: "reconnect"; readonly accounts: readonly A[] }
  | { readonly state: "unavailable"; readonly accounts: readonly A[] }
  | { readonly state: "ready" } {
  if (app.activeDeployment === null) return { state: "not-deployed" };
  const issues = accountSelectionIssues(app, accounts);
  if (issues.length > 0) return { state: "selection", issues };
  const ids = selectedIds(app);
  const selected = accounts.filter((account) => ids.includes(account.id));
  const unavailable = selected.filter((account) => account.signIn?.state === "unavailable");
  if (unavailable.length > 0) return { state: "unavailable", accounts: unavailable };
  const reconnect = selected.filter((account) => accountNeedsSignIn(account));
  if (reconnect.length > 0) return { state: "reconnect", accounts: reconnect };
  return { state: "ready" };
}
/** Public OAuth endpoints can supply a favicon domain; credentials are never inspected. */
export function providerDisplayUrl(definition: ProviderDefinition | undefined): string | null {
  if (definition)
    for (const method of Object.values(definition.auth)) {
      if (method.type === "oauth2")
        return new URL(
          method.discover !== undefined
            ? method.discover
            : (method.authorizationUrl ?? method.tokenUrl),
        ).origin;
    }
  return null;
}
/** A consistent short date for account/source metadata. */
export const displayDate = (value: Date) =>
  value.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
