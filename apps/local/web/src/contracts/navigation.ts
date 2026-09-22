import { ProfileId } from "@executor-js/sdk";
import { AppView } from "@executor-js/ui/contracts/dashboard";
import { AccountId, AppId, ProviderId } from "@executor-js/sdk";
import { Option, Schema } from "effect";

/** Dashboard areas used by route metadata to highlight the sidebar. */
export type NavigationSection = "apps" | "accounts" | "connect" | "approvals";

/** Existing app-detail query parameters; an absent view opens the app overview. */
export interface AppSearch {
  readonly view?: AppView | undefined;
  readonly tool?: string | undefined;
  readonly profile?: ProfileId | undefined;
}

/** Account creation can return to the originating app requirement. */
export interface AddAccountSearch {
  readonly provider?: ProviderId | undefined;
  readonly app?: AppId | undefined;
  readonly slot?: string | undefined;
  readonly profile?: ProfileId | undefined;
}

/** Setup offers a newly connected account, then validates its compatibility. */
export interface SetupSearch {
  readonly selected?: AccountId | undefined;
  readonly slot?: string | undefined;
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

/** Parse optional provider and app identities at the URL boundary. */
export function parseAddAccountSearch(search: Record<string, unknown>): AddAccountSearch {
  const provider = Schema.decodeUnknownOption(ProviderId)(search.provider);
  const app = Schema.decodeUnknownOption(AppId)(search.app);
  const slot = text(search.slot);
  return {
    provider: Option.getOrUndefined(provider),
    app: Option.getOrUndefined(app),
    slot: Option.getOrUndefined(slot),
    profile: Option.getOrUndefined(Schema.decodeUnknownOption(ProfileId)(search.profile)),
  };
}

/** Parse the account candidate without granting it access to the app. */
export function parseSetupSearch(search: Record<string, unknown>): SetupSearch {
  const selected = Schema.decodeUnknownOption(AccountId)(search.selected);
  const slot = text(search.slot);
  return {
    selected: Option.getOrUndefined(selected),
    slot: Option.getOrUndefined(slot),
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
  if (section === "connect") return "Connect";
  if (section === "account-connect") return "Connect account";
  if (section === "api" && item === "oauth") return "Connecting account";
  if (section === "apps") {
    if (item === "add") return action === "custom" ? "Add custom app" : "Add app";
    if (action === "delete") return "Delete app";
    if (action === "setup") return "Choose accounts";
    return item ? "App" : "Apps";
  }
  if (section === "accounts") {
    if (item === "add") return "Connect account";
    if (action === "credentials") return "Update credentials";
    if (action === "disconnect") return "Disconnect account";
    return item ? "Account" : "Accounts";
  }
  return "Dashboard";
}
