import { ProfileId } from "@executor-js/sdk";
import { AppView } from "@executor-js/ui/contracts/dashboard";
import { AccountId } from "@executor-js/sdk";
import { Option, Schema } from "effect";

/** Dashboard areas used by route metadata to highlight the sidebar. */
export type NavigationSection = "apps" | "accounts" | "connect" | "approvals";

/** Existing app-detail query parameters; an absent view opens the app overview. */
export interface AppSearch {
  readonly view?: AppView | undefined;
  readonly tool?: string | undefined;
  readonly profile?: ProfileId | undefined;
}

/** The account list marks a linked account, which has no page of its own. */
export interface AccountsSearch {
  readonly account?: AccountId | undefined;
}

/** Setup opens the app's accounts, optionally for one profile. */
export interface SetupSearch {
  readonly profile?: ProfileId | undefined;
}

const text = Schema.decodeUnknownOption(Schema.NonEmptyString);

/** Ignore unsupported views and empty tool names, preserving existing deep links. */
export function parseAppSearch(search: Record<string, unknown>): AppSearch {
  const view = Schema.decodeUnknownOption(AppView)(search.view);
  const tool = text(search.tool);
  return {
    profile: Option.getOrUndefined(Schema.decodeUnknownOption(ProfileId)(search.profile)),
    view: Option.getOrUndefined(view),
    tool: Option.getOrUndefined(tool),
  };
}

/** Ignore a malformed account identity instead of rejecting the list. */
export function parseAccountsSearch(search: Record<string, unknown>): AccountsSearch {
  return {
    account: Option.getOrUndefined(Schema.decodeUnknownOption(AccountId)(search.account)),
  };
}

/** Ignore a malformed profile identity. */
export function parseSetupSearch(search: Record<string, unknown>): SetupSearch {
  return {
    profile: Option.getOrUndefined(Schema.decodeUnknownOption(ProfileId)(search.profile)),
  };
}

/** Keep conventional URL query values as strings; take the first repeated value like URLSearchParams.get. */
export function parseSearchParams(search: string): Record<string, string> {
  const values = new Map<string, string>();
  for (const [key, value] of new URLSearchParams(search)) {
    if (!values.has(key)) values.set(key, value);
  }
  return Object.fromEntries(values);
}

/** Fallback labels for local routes; loaded app/account views register their own names. */
export function localPageTitle(pathname: string): string {
  const [section, item, action] = pathname.split("/").filter(Boolean);
  if (section === "webhooks") return "Webhook setup";
  if (section === "mcp" && item === "approve") return "Review request";
  if (section === "app-auth") return "Sign in to app";
  if (section === "approvals") return item ? "Review request" : "Approvals";
  if (section === "connect") return "Connections";
  if (section === "account-connect") return "Connect account";
  if (section === "api" && item === "oauth") return "Connecting account";
  if (section === "apps") {
    if (item === "add") return action === "custom" ? "Add custom app" : "Add app";
    if (action === "delete") return "Delete app";
    if (action === "setup") return "Choose accounts";
    return item ? "App" : "Apps";
  }
  if (section === "accounts") return "Accounts";
  return "Dashboard";
}
