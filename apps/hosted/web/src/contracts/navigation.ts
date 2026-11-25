import { AccountConnectionId, AccountId, OAuthClientId } from "@executor-js/sdk";
import { GrantId } from "@executor-js/mcp-auth/grants";
import { AppView, AppViewFromUrl, AssistantId } from "@executor-js/ui/contracts/dashboard";
import { Option, Schema } from "effect";
import { OrganizationId } from "@executor-js/hosted-server/organization";
import type { AgentBaseline } from "./mcp-connections.ts";

export const ClientRecovery = Schema.Union([Schema.Literal("change"), OAuthClientId]);
export const ConnectionSearch = Schema.Struct({
  client: Schema.optionalKey(ClientRecovery),
});

export function parseConnectionSearch(search: Record<string, unknown>): {
  readonly connection?: AccountConnectionId | undefined;
  readonly client?: typeof ClientRecovery.Type | undefined;
} {
  return {
    connection: Option.getOrUndefined(
      Schema.decodeUnknownOption(AccountConnectionId)(search.connection),
    ),
    client: Option.getOrUndefined(Schema.decodeUnknownOption(ClientRecovery)(search.client)),
  };
}

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

export const OrganizationResume = Schema.Struct({
  organization: OrganizationId,
  reference: Schema.optionalKey(Schema.NonEmptyString),
  userId: Schema.NonEmptyString,
});

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

export const SetupHandoff = Schema.Struct({
  assistant: AssistantId,
  agent: GrantId,
});
export type SetupHandoff = typeof SetupHandoff.Type;

export function parseAccountsSetupSearch(search: Record<string, unknown>): Partial<SetupHandoff> {
  return Option.match(Schema.decodeUnknownOption(SetupHandoff)(search), {
    onNone: () => ({}),
    onSome: ({ assistant, agent }) => ({ assistant, agent }),
  });
}

export const setupHandoff = (search: Partial<SetupHandoff>): SetupHandoff | undefined =>
  search.assistant === undefined || search.agent === undefined
    ? undefined
    : { assistant: search.assistant, agent: search.agent };

declare module "@tanstack/history" {
  interface HistoryState {
    organizationResume?: typeof OrganizationResume.Type;
    agentSetup?: AgentBaseline;
  }
}
export function parseAppSearch(search: Record<string, unknown>): ReturnType<
  typeof parseConnectionSearch
> & {
  readonly view?: AppView | undefined;
  readonly tool?: string | undefined;
} {
  return {
    ...parseConnectionSearch(search),
    view: Option.getOrUndefined(Schema.decodeUnknownOption(AppViewFromUrl)(search.view)),
    tool: Option.getOrUndefined(Schema.decodeUnknownOption(Schema.NonEmptyString)(search.tool)),
  };
}

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
  const [root, section, page, item] = pathname.split("/").filter(Boolean);
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
  if (page === "setup") return item === "assistant" ? "Continue in your agent" : "Connect accounts";
  if (page === "organization") return "Settings";
  if (page === "approvals") return item ? "Review request" : "Approvals";
  if (page === "groups") return item ? "Group" : "Groups";
  if (page === "activity") return "Activity";
  if (page === "connect") return item ? "Connection" : "Connections";
  if (page === "webhooks") return "Webhook setup";
  if (page === "connections") return "Connect account";
  if (page === "apps") return item === "add" ? "App catalog" : item ? "App" : "Apps";
  if (page === "accounts") return "Accounts";
  return "Dashboard";
}

export const keepFragment = (url: string): string =>
  url.includes("#") ? url : `${url}${window.location.hash}`;

export const signInCallback = (redirect: string): string =>
  `/login?redirect=${encodeURIComponent(redirect)}`;

export function parseAccountSearch(search: Record<string, unknown>): {
  readonly organization?: string | undefined;
} {
  return {
    organization: Option.getOrUndefined(
      Schema.decodeUnknownOption(Schema.NonEmptyString)(search.organization),
    ),
  };
}
