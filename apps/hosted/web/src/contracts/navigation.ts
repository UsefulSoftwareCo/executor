import { AccountConnectionId, AccountId } from "@executor-js/sdk";
import { GrantId } from "@executor-js/mcp-auth/grants";
import { AppView, AssistantId } from "@executor-js/ui/contracts/dashboard";
import { Option, Schema } from "effect";
import { OrganizationId } from "@executor-js/hosted-server/organization";
import type { AgentBaseline } from "./mcp-connections.ts";

/** A failed OAuth attempt can reopen its client fields without placing credentials in the URL. */
export const ConnectionSearch = Schema.Struct({
  client: Schema.optionalKey(Schema.Literal("change")),
});

/** Direct links and refreshes retain a connection dialog on its app page. */
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

/**
 * The account list marks a linked account, which has no page of its own, and keeps the OAuth
 * client manager open on refresh.
 */
export function parseAccountsSearch(search: Record<string, unknown>): {
  readonly account?: AccountId | undefined;
  readonly manage?: "oauth-clients" | undefined;
} {
  return {
    account: Option.getOrUndefined(Schema.decodeUnknownOption(AccountId)(search.account)),
    manage: Option.getOrUndefined(
      Schema.decodeUnknownOption(Schema.Literal("oauth-clients"))(search.manage),
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

/**
 * Agent setup's URL names the screen the member chose: the assistants, one assistant's guide, or
 * its first prompt for the agent that connected. Unknown values open the assistants; a first prompt
 * without an agent opens the guide. The page confirms the agent's grant before calling it connected.
 */
export function parseAgentSetupSearch(
  search: Record<string, unknown>,
):
  | { readonly assistant?: AssistantId | undefined; readonly step?: undefined }
  | { readonly assistant: AssistantId; readonly step: "prompt"; readonly agent: GrantId } {
  const assistant = Option.getOrUndefined(
    Schema.decodeUnknownOption(AssistantId)(search.assistant),
  );
  const agent = Option.getOrUndefined(Schema.decodeUnknownOption(GrantId)(search.agent));
  const prompt =
    assistant !== undefined &&
    agent !== undefined &&
    Option.isSome(Schema.decodeUnknownOption(Schema.Literal("prompt"))(search.step));
  return prompt ? { assistant, step: "prompt", agent } : { assistant };
}

declare module "@tanstack/history" {
  interface HistoryState {
    organizationResume?: typeof OrganizationResume.Type;
    /** The baseline a guide's history entry compares new agents with, kept for Back and reload. */
    agentSetup?: AgentBaseline;
  }
}
/** App tabs keep their view on refresh in both hosted products. */
export function parseAppSearch(search: Record<string, unknown>): ReturnType<
  typeof parseConnectionSearch
> & {
  readonly view?: AppView | undefined;
  readonly tool?: string | undefined;
} {
  return {
    ...parseConnectionSearch(search),
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
  if (pathname === "/device") return "Connect a device";
  if (pathname === "/oauth/callback") return "Connecting account";
  const [root, section, page, item, action] = pathname.split("/").filter(Boolean);
  if (root === "account")
    return section === "tokens"
      ? "Tokens"
      : section === "security"
        ? "Security"
        : section === "profile"
          ? "Profile"
          : "Account";
  if (root !== "org" || page === undefined) return "Organizations";
  if (extraPages[page] !== undefined) return extraPages[page];
  if (page === "organization") return "Settings";
  if (page === "approvals") return item ? "Review request" : "Approvals";
  if (page === "groups") return item ? "Group" : "Groups";
  if (page === "connect") return "Connections";
  if (page === "webhooks") return "Webhook setup";
  if (page === "connections") return "Connect account";
  if (page === "apps")
    return item === "add"
      ? action === "custom"
        ? "Add custom app"
        : "Add app"
      : item
        ? "App"
        : "Apps";
  if (page === "accounts") return "Accounts";
  return "Dashboard";
}

/**
 * Sign-in finishes with a fresh document. Keep the current fragment, as an HTTP redirect without its
 * own fragment would, so an app deep link's fragment survives signing in on the way.
 */
export const keepFragment = (url: string): string =>
  url.includes("#") ? url : `${url}${window.location.hash}`;

/** Return providers through sign-in completion without changing the encoded final destination. */
export const signInCallback = (redirect: string): string =>
  `/login?redirect=${encodeURIComponent(redirect)}`;

/** Account pages can carry the organization a visitor came from; it only preselects choices. */
export function parseAccountSearch(search: Record<string, unknown>): {
  readonly organization?: string | undefined;
} {
  return {
    organization: Option.getOrUndefined(
      Schema.decodeUnknownOption(Schema.NonEmptyString)(search.organization),
    ),
  };
}
