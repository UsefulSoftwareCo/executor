import { AccountConnectionId, ProfileId } from "@executor-js/sdk";
import { AppView } from "@executor-js/ui/contracts/dashboard";
import { Option, Schema } from "effect";
import { OrganizationId } from "@executor-js/hosted-server/organization";

/** A failed OAuth attempt can reopen its client fields without placing credentials in the URL. */
export const ConnectionSearch = Schema.Struct({
  client: Schema.optionalKey(Schema.Literal("change")),
});

/** Direct links and refreshes retain a connection dialog on its app or account page. */
export function parseConnectionSearch(search: Record<string, unknown>): {
  readonly connection?: AccountConnectionId | undefined;
  readonly client?: "change" | undefined;
} {
  return {
    connection: Option.getOrUndefined(
      Schema.decodeUnknownOption(AccountConnectionId)(search.connection),
    ),
    client: Option.getOrUndefined(
      Schema.decodeUnknownOption(Schema.Literal("change"))(search.client),
    ),
  };
}

/** History marks only automatic root restoration; explicit links keep their own targets. */
export const OrganizationResume = Schema.Struct({
  organization: OrganizationId,
  // The initial URL reference used for the restored visit.
  reference: Schema.optionalKey(Schema.NonEmptyString),
  userId: Schema.NonEmptyString,
});

declare module "@tanstack/history" {
  interface HistoryState {
    organizationResume?: typeof OrganizationResume.Type;
  }
}
/** App tabs keep their selection on refresh in both hosted products. */
export function parseAppSearch(search: Record<string, unknown>): ReturnType<
  typeof parseConnectionSearch
> & {
  readonly view?: AppView | undefined;
  readonly tool?: string | undefined;
  readonly profile?: ProfileId | undefined;
} {
  return {
    ...parseConnectionSearch(search),
    profile: Option.getOrUndefined(Schema.decodeUnknownOption(ProfileId)(search.profile)),
    view: Option.getOrUndefined(Schema.decodeUnknownOption(AppView)(search.view)),
    tool: Option.getOrUndefined(Schema.decodeUnknownOption(Schema.NonEmptyString)(search.tool)),
  };
}

/** Hosted route labels use exact segments; host-only pages supply their own labels. */
export function hostedPageTitle(
  pathname: string,
  extraPages: Readonly<Record<string, string>> = {},
): string {
  if (pathname.startsWith("/mcp/approve/")) return "Review request";
  if (pathname === "/app-auth") return "Sign in to app";
  if (pathname === "/login") return "Sign in";
  if (pathname === "/invite") return "Invitation";
  if (pathname === "/mcp/authorize") return "Authorize client";
  if (pathname === "/oauth/callback") return "Connecting account";
  const [root, , page, item, action] = pathname.split("/").filter(Boolean);
  if (root !== "org" || page === undefined) return "Organizations";
  if (extraPages[page] !== undefined) return extraPages[page];
  if (page === "organization") return "Settings";
  if (page === "approvals") return item ? "Review request" : "Approvals";
  if (page === "groups") return item ? "Group" : "Groups";
  if (page === "connect") return "Connect";
  if (page === "webhooks") return "Webhook setup";
  if (page === "connections") return "Connect account";
  if (page === "apps")
    return item === "add"
      ? action === "custom"
        ? "Add custom app"
        : "Add app"
      : action === "setup"
        ? "Choose accounts"
        : item
          ? "App"
          : "Apps";
  if (page === "accounts")
    return action === "disconnect" ? "Disconnect account" : item ? "Account" : "Accounts";
  return "Dashboard";
}

/** Return providers through sign-in completion without changing the encoded final destination. */
export const signInCallback = (redirect: string): string =>
  `/login?redirect=${encodeURIComponent(redirect)}`;

/** Account setup targets an explicit personal selection, or starts a new one. */
export function parseSetupSearch(search: Record<string, unknown>): {
  profile?: ProfileId | undefined;
} {
  return {
    profile: Option.getOrUndefined(Schema.decodeUnknownOption(ProfileId)(search.profile)),
  };
}
