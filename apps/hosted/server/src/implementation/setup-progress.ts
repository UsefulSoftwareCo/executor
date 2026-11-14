/** What a member has done of a new team's setup steps, read on the server. */
import type { GrantId } from "@executor-js/mcp-auth";
import { Effect } from "effect";
import { CurrentUserId } from "../contracts/auth.ts";
import { executorCatalogPackage } from "../contracts/catalog.ts";
import { HostedExecutor } from "../contracts/executor.ts";
import { McpAuthentication } from "../contracts/mcp.ts";
import { CurrentOrganization, OrganizationForbidden } from "../contracts/organization.ts";
import { callerLinkedAccounts } from "./app-accounts.ts";

export interface SetupProgress {
  /** The member linked an account to one of the team's apps other than Executor's own. */
  readonly accounts: boolean;
  /** The member's newest agent connected over MCP to this team; API clients do not count. */
  readonly agent: GrantId | undefined;
}

/**
 * The current member's progress through the current organization's setup steps. Each step's page
 * counts a narrower set (accounts of catalog apps, an agent connected while it is open), so
 * whatever a page calls done, this calls done too.
 */
export const memberSetupProgress = Effect.gen(function* () {
  const organization = yield* CurrentOrganization;
  const userId = yield* CurrentUserId;
  if (userId === undefined) return yield* new OrganizationForbidden();
  const executor = yield* Effect.flatten(HostedExecutor);
  const auth = yield* McpAuthentication;
  // Executor's own app is how the assistant reaches the others, as on the account step.
  const apps = (yield* executor.apps.list({ owner: organization.owner }))
    .filter((app) => app.copiedFrom?.name !== executorCatalogPackage)
    .map((app) => app.id);
  const linked = apps.length === 0 ? [] : yield* callerLinkedAccounts(apps);
  const agents = yield* auth.connections.agents({
    userId,
    resource: organization.organization,
  });
  const [newest] = agents
    .filter((agent) => agent.access.kind !== "api")
    .toSorted((a, b) => b.connectedAt.localeCompare(a.connectedAt));
  return { accounts: linked.length > 0, agent: newest?.id } satisfies SetupProgress;
}).pipe(Effect.withSpan("setup.progress"));
