import type {
  Account,
  AccountCheckStatus,
  AccountHealth,
  AccountId,
  App,
  AppId,
  VersionId,
  Provider,
  ProviderDefinition,
  ToolRouter,
  ToolSummary,
} from "@executor-js/sdk";
import type { CatalogImport } from "@executor-js/catalog/contracts";
import type { CatalogIcons } from "./icons.ts";
import {
  missingRequirements,
  usedAccounts,
  type AppAccountLink,
  type SharedAppLink,
  type RequirementAccounts,
} from "./app-accounts.ts";
import type {
  VersionDisplay,
  SourceDisplayFile,
} from "@executor-js/app-management/contracts/source-display";
import type { Atom, AsyncResult } from "effect/reactivity";
import { Schema, SchemaGetter, type Cause } from "effect";
import type { ComponentType, ReactNode } from "react";
import { parse } from "tldts";

export interface ToolCatalog {
  readonly tools: readonly ToolSummary[];
  readonly routers: readonly ToolRouter[];
}

export type AccountSummary = Account & {
  readonly providerName?: string;
  readonly providerUrl?: string | null;
  readonly signIn?:
    | { readonly state: "saved"; readonly reconnectAt: Date | null }
    | { readonly state: "reconnect" | "unavailable" };
  readonly health?: AccountHealth;
};
export interface AccountDetail {
  readonly account: AccountSummary;
  readonly provider: Provider;
  readonly apps: readonly App[];
  readonly health?: AccountHealth;
  readonly revocation: "automatic" | "manual";
  readonly canManage: boolean;
}
export interface Inventory {
  readonly apps: readonly App[];
  readonly links: readonly AppAccountLink[];
  readonly appLinks: readonly SharedAppLink[];
  readonly accounts: readonly AccountSummary[];
}
export type Query<A, E> = Atom.Atom<AsyncResult.AsyncResult<A, E>>;
export interface QueryProps<A, E> {
  readonly query: Query<A, E>;
  readonly Failure: ComponentType<FailureProps<NoInfer<E>>>;
}
export interface AppVersionsProps<E> {
  readonly app: App;
  readonly versions: readonly {
    readonly id: VersionId;
    readonly createdAt: Date;
    readonly fileCount: number;
  }[];
  readonly version: VersionId;
  readonly onVersionChange: (version: VersionId | undefined) => void;
  readonly query: Query<VersionDisplay, E>;
  readonly file: (version: VersionId, path: string) => Query<SourceDisplayFile, E>;
  readonly Failure: ComponentType<FailureProps<NoInfer<E>>>;
  readonly actions?: ReactNode;
}
export interface InstallApp extends CatalogImport {
  readonly name: string;
}
export interface MutationProps<Input, A, E> {
  readonly mutation: Atom.AtomResultFn<Input, A, E>;
  readonly Failure: ComponentType<FailureProps<NoInfer<E>>>;
}
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
  "versions",
  "settings",
]);
export type AppView = typeof AppView.Type;
export const AppViewFromUrl = Schema.Union([
  AppView,
  Schema.Literal("deployments").pipe(
    Schema.decodeTo(Schema.Literal("versions"), {
      decode: SchemaGetter.transform(() => "versions" as const),
      encode: SchemaGetter.transform(() => "deployments" as const),
    }),
  ),
]);
export const AssistantId = Schema.Literals([
  "claude",
  "chatgpt",
  "opencode",
  "claude-code",
  "codex",
  "devin",
  "grok-bot",
  "grok",
  "muse",
  "other",
]);
export type AssistantId = typeof AssistantId.Type;
export interface AppLinkProps {
  readonly app: AppId;
  readonly view?: AppView;
  readonly tool?: string;
  readonly className?: string;
  readonly children: ReactNode;
  readonly "aria-label"?: string;
  readonly "aria-current"?: "page" | undefined;
}
export interface AccountLinkProps {
  readonly className?: string;
  readonly account: AccountId;
  readonly children: ReactNode;
}
export interface FailureProps<E> {
  readonly cause: Cause.Cause<E>;
  readonly retry?: (() => void) | undefined;
  readonly retrying?: boolean | undefined;
  readonly layout?: "inline" | "compact" | undefined;
}
export interface DashboardBindings {
  readonly catalogIcons: Atom.Atom<CatalogIcons>;
  readonly AppLink: ComponentType<AppLinkProps>;
  readonly AccountLink: ComponentType<AccountLinkProps>;
  readonly appIconUrl?: ((app: App) => string | undefined) | undefined;
}

export const accountNeedsSignIn = (account: AccountSummary, now = Date.now()) =>
  account.signIn?.state === "reconnect" ||
  (account.signIn?.state === "saved" &&
    account.signIn.reconnectAt !== null &&
    account.signIn.reconnectAt.getTime() <= now);
export const currentAccountCheck = (account: AccountSummary, app: AppId) => {
  const check = account.health?.apps.find((entry) => entry.app === app)?.check;
  return check?.current === true ? check : undefined;
};
export const withCheckedApps = <
  L extends { readonly account: { readonly id: AccountId }; readonly health?: AccountHealth },
>(
  link: L,
  checked: AccountHealth,
): L =>
  link.health === undefined || link.account.id !== checked.account
    ? link
    : {
        ...link,
        health: {
          ...link.health,
          apps: link.health.apps.map(
            (entry) => checked.apps.find((item) => item.app === entry.app) ?? entry,
          ),
        },
      };
export interface AccountCheckWarning<A extends AccountSummary> {
  readonly account: A;
  readonly status: Exclude<AccountCheckStatus, "healthy" | "credentials_rejected">;
}
export function appToolReadiness<A extends AccountSummary>(
  app: App,
  requirements: readonly RequirementAccounts<A>[],
):
  | { readonly state: "not-deployed" }
  | { readonly state: "missing"; readonly slots: readonly string[] }
  | { readonly state: "reconnect"; readonly accounts: readonly A[] }
  | { readonly state: "unavailable"; readonly accounts: readonly A[] }
  | { readonly state: "rejected"; readonly accounts: readonly A[] }
  | { readonly state: "ready"; readonly warnings: readonly AccountCheckWarning<A>[] } {
  if (app.activeVersion === null) return { state: "not-deployed" };
  const selected = usedAccounts(requirements);
  if (selected === undefined)
    return {
      state: "missing",
      slots: missingRequirements(requirements).map((entry) => entry.slot),
    };
  const unavailable = selected.filter((account) => account.signIn?.state === "unavailable");
  if (unavailable.length > 0) return { state: "unavailable", accounts: unavailable };
  const reconnect = selected.filter((account) => accountNeedsSignIn(account));
  if (reconnect.length > 0) return { state: "reconnect", accounts: reconnect };
  const rejected = selected.filter(
    (account) => currentAccountCheck(account, app.id)?.status === "credentials_rejected",
  );
  if (rejected.length > 0) return { state: "rejected", accounts: rejected };
  const warnings = selected.flatMap((account): AccountCheckWarning<A>[] => {
    const status = currentAccountCheck(account, app.id)?.status;
    return status === undefined || status === "healthy" || status === "credentials_rejected"
      ? []
      : [{ account, status }];
  });
  return { state: "ready", warnings };
}
export const emptyManyRequirements = <A extends AccountSummary>(
  requirements: readonly RequirementAccounts<A>[],
) =>
  requirements.filter(
    (entry) => entry.known && entry.requirement.cardinality === "many" && entry.linked.length === 0,
  );
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
  const hosts = [...new Set(definition?.hosts ?? [])];
  const host = hosts.length === 1 ? hosts[0] : undefined;
  if (host === undefined || host.startsWith("*.") || !URL.canParse(`https://${host}`)) return null;
  const url = new URL(`https://${host}`);
  const lookup = parse(url.hostname, { allowPrivateDomains: false });
  if (!lookup.isIcann || lookup.domain === null) return null;
  return url.hostname === lookup.domain || url.hostname === `www.${lookup.domain}`
    ? url.origin
    : null;
}
