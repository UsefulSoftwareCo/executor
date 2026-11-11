/** Display contracts shared by dashboards. Hosts retain ownership, auth, and transport semantics. */
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

/** An app's live tools with the routers that group them, such as one MCP server each. */
export interface ToolCatalog {
  readonly tools: readonly ToolSummary[];
  readonly routers: readonly ToolRouter[];
}

/** Display metadata may be absent in a host that has not exposed provider/status details yet. */
export type AccountSummary = Account & {
  readonly providerName?: string;
  readonly providerUrl?: string | null;
  readonly signIn?:
    | { readonly state: "saved"; readonly reconnectAt: Date | null }
    | { readonly state: "reconnect" | "unavailable" };
  /** Checks by the apps that use the account, when the host exposes them. */
  readonly health?: AccountHealth;
};
/** Safe account detail shared by hosts; management authority remains product-owned. */
export interface AccountDetail {
  readonly account: AccountSummary;
  readonly provider: Provider;
  readonly apps: readonly App[];
  /** Each listed app's latest check, when the host exposes checks. */
  readonly health?: AccountHealth;
  /** `automatic`: deleting the account asks its service to revoke access; `manual`: it does not. */
  readonly revocation: "automatic" | "manual";
  readonly canManage: boolean;
}
/** The common inventory contains no product permission or organization fields. */
export interface Inventory {
  readonly apps: readonly App[];
  /** The caller's linked accounts for each listed app. */
  readonly links: readonly AppAccountLink[];
  readonly accounts: readonly AccountSummary[];
}
/** Any Effect Atom source, including a live stream or a one-shot HTTP query. */
export type Query<A, E> = Atom.Atom<AsyncResult.AsyncResult<A, E>>;
/** The atom determines E; its failure renderer must handle that complete error union. */
export interface QueryProps<A, E> {
  readonly query: Query<A, E>;
  readonly Failure: ComponentType<FailureProps<NoInfer<E>>>;
}
/** Version history and retained source supplied by a product-specific dashboard adapter. */
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
  /** Reads one file of the listed version when the listing did not inline it. */
  readonly file: (version: VersionId, path: string) => Query<SourceDisplayFile, E>;
  readonly Failure: ComponentType<FailureProps<NoInfer<E>>>;
  readonly actions?: ReactNode;
  /** A host's status line above the versions, such as an available update. */
  readonly notice?: ReactNode;
}
/** Common command input; a host adapter supplies its own API route parameters. */
export interface InstallApp extends CatalogImport {
  readonly name: string;
}
/** A typed command and its operation-specific failure renderer. */
export interface MutationProps<Input, A, E> {
  readonly mutation: Atom.AtomResultFn<Input, A, E>;
  readonly Failure: ComponentType<FailureProps<NoInfer<E>>>;
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
  "versions",
  "settings",
]);
export type AppView = typeof AppView.Type;
/**
 * The view a URL names. `deployments`, the former name of `versions`, still opens it, so links
 * saved before the rename keep working.
 */
export const AppViewFromUrl = Schema.Union([
  AppView,
  Schema.Literal("deployments").pipe(
    Schema.decodeTo(Schema.Literal("versions"), {
      decode: SchemaGetter.transform(() => "versions" as const),
      encode: SchemaGetter.transform(() => "deployments" as const),
    }),
  ),
]);
/** Assistants with a setup guide, as setup URLs name them. */
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
/** Host routing remains typed by that host's TanStack tree. */
export interface AppLinkProps {
  readonly app: AppId;
  readonly view?: AppView;
  readonly tool?: string;
  readonly className?: string;
  readonly children: ReactNode;
  readonly "aria-label"?: string;
  readonly "aria-current"?: "page" | undefined;
}
/** Accounts have no page of their own; a link opens the account list at that account. */
export interface AccountLinkProps {
  readonly className?: string;
  readonly account: AccountId;
  readonly children: ReactNode;
}
/** Expected failures are formatted by the product without leaking transport data. */
export interface FailureProps<E> {
  readonly cause: Cause.Cause<E>;
  readonly retry?: (() => void) | undefined;
  readonly retrying?: boolean | undefined;
  /** Forms ask for `compact`: the failure sits among their fields, without a card or error code. */
  readonly layout?: "inline" | "compact" | undefined;
}
/** Only error-independent presentation belongs in context. Queries keep their own error types. */
export interface DashboardBindings {
  /** Catalog apps' icons by package and by name; see `catalogIconsAtom`. */
  readonly catalogIcons: Atom.Atom<CatalogIcons>;
  readonly AppLink: ComponentType<AppLinkProps>;
  readonly AccountLink: ComponentType<AccountLinkProps>;
}

/** Token expiry needs user action only when the host cannot refresh it. */
export const accountNeedsSignIn = (account: AccountSummary, now = Date.now()) =>
  account.signIn?.state === "reconnect" ||
  (account.signIn?.state === "saved" &&
    account.signIn.reconnectAt !== null &&
    account.signIn.reconnectAt.getTime() <= now);
/** An app's latest check of an account. Outdated or missing checks make no claim. */
export const currentAccountCheck = (account: AccountSummary, app: AppId) => {
  const check = account.health?.apps.find((entry) => entry.app === app)?.check;
  return check?.current === true ? check : undefined;
};
/**
 * A link with the app results of a check of its account that just ran, so the link shows them
 * before the next read of the links. Other details, such as the reported identity, wait for it.
 */
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
/** A current failed check that does not prove the credentials are bad; the app can still open. */
export interface AccountCheckWarning<A extends AccountSummary> {
  readonly account: A;
  readonly status: Exclude<AccountCheckStatus, "healthy" | "credentials_rejected">;
}
/**
 * Account metadata can block tool discovery; missing credential-health metadata makes no claim.
 * Only a current check that rejected the credentials blocks; other failed checks are warnings.
 */
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
/** many() requirements known to have no account: their tools list empty rather than failing. */
export const emptyManyRequirements = <A extends AccountSummary>(
  requirements: readonly RequirementAccounts<A>[],
) =>
  requirements.filter(
    (entry) => entry.known && entry.requirement.cardinality === "many" && entry.linked.length === 0,
  );
/** Public provider metadata can supply a favicon domain; credentials are never inspected. */
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
  // A renamed API-key provider has neither an OAuth origin nor a catalog name. Only use an
  // unambiguous exact public host; never send private, wildcard or multi-host grants to the proxy.
  const hosts = [...new Set(definition?.hosts ?? [])];
  const host = hosts.length === 1 ? hosts[0] : undefined;
  if (host === undefined || host.startsWith("*.") || !URL.canParse(`https://${host}`)) return null;
  const url = new URL(`https://${host}`);
  const domain = parse(url.hostname);
  return domain.isIcann && domain.domain !== null ? url.origin : null;
}
