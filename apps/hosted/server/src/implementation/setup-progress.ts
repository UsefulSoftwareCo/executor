import type { GrantId } from "@executor-js/mcp-auth";
import { Effect } from "effect";
import { CurrentUserId } from "../contracts/auth.ts";
import { executorCatalogPackage } from "../contracts/catalog.ts";
import { HostedExecutor } from "../contracts/executor.ts";
import { McpAuthentication } from "../contracts/mcp.ts";
import { CurrentOrganization, OrganizationForbidden } from "../contracts/organization.ts";
import { callerLinkedAccounts } from "./app-accounts.ts";

export interface SetupProgress {
  readonly accounts: boolean;
  readonly agent: GrantId | undefined;
}

export const memberSetupProgress = Effect.gen(function* () {
  const organization = yield* CurrentOrganization;
  const userId = yield* CurrentUserId;
  if (userId === undefined) return yield* new OrganizationForbidden();
  const executor = yield* Effect.flatten(HostedExecutor);
  const auth = yield* McpAuthentication;
  const apps = (yield* executor.apps.list({ owner: organization.owner }))
    .filter((app) => app.copiedFrom?.name !== executorCatalogPackage)
    .map((app) => app.id);
  const linked = apps.length === 0 ? [] : yield* callerLinkedAccounts(apps);
  const agents = yield* auth.connections.agents({
    userId,
    resource: organization.organization,
  });
  const [newest] = agents
    .filter((agent) => agent.access.kind !== "api" && agent.access.kind !== "desktop")
    .toSorted((a, b) => b.connectedAt.localeCompare(a.connectedAt));
  return { accounts: linked.length > 0, agent: newest?.id } satisfies SetupProgress;
}).pipe(Effect.withSpan("setup.progress"));
