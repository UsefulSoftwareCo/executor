import { AppView, AppViewFromUrl } from "@executor-js/ui/contracts/dashboard";
import { AccountId } from "@executor-js/sdk";
import { Option, Schema } from "effect";

export type NavigationSection = "apps" | "accounts" | "connect" | "approvals";

export interface AppSearch {
  readonly view?: AppView | undefined;
  readonly tool?: string | undefined;
}

export interface AccountsSearch {
  readonly account?: AccountId | undefined;
}

const text = Schema.decodeUnknownOption(Schema.NonEmptyString);

export function parseAppSearch(search: Record<string, unknown>): AppSearch {
  const view = Schema.decodeUnknownOption(AppViewFromUrl)(search.view);
  const tool = text(search.tool);
  return {
    view: Option.getOrUndefined(view),
    tool: Option.getOrUndefined(tool),
  };
}

export function parseAccountsSearch(search: Record<string, unknown>): AccountsSearch {
  return {
    account: Option.getOrUndefined(Schema.decodeUnknownOption(AccountId)(search.account)),
  };
}

export function parseSearchParams(search: string): Record<string, string> {
  const values = new Map<string, string>();
  for (const [key, value] of new URLSearchParams(search)) {
    if (!values.has(key)) values.set(key, value);
  }
  return Object.fromEntries(values);
}

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
    if (item === "add") return "App catalog";
    if (action === "delete") return "Delete app";
    if (action === "setup") return "Accounts";
    return item ? "App" : "Apps";
  }
  if (section === "accounts") return "Accounts";
  return "Dashboard";
}
