/* oxlint-disable executor/no-try-catch-or-throw, executor/no-instanceof-error, executor/no-unknown-error-message -- boundary: catalog aggregation degrades optional integrations independently */
import { Effect } from "effect";
import {
  automationAgentsToCatalogItems,
  automationSkillsToCatalogItems,
  EMPTY_AUTOMATION_BUILDER_CATALOG,
  type AutomationBuilderCatalog,
  type AutomationExecutorSourceCatalogItem,
  type AutomationExecutorToolCatalogItem,
  type AutomationRepoCatalogItem,
  type AutomationRepoOwnerCatalogItem,
} from "@/lib/automation/catalog";
import { listAgentLibrary } from "@/lib/agents/repository";
import { getInstallationsByUserId } from "@/lib/db/installations";
import { getUserPreferences } from "@/lib/db/user-preferences";
import { createOpenAgentsExecutor } from "@/lib/executor/runtime";
import { listUserInstallationRepositories } from "@/lib/github/repos";
import { getUserGitHubToken } from "@/lib/github/token";
import { getServerSession } from "@/lib/session/get-server-session";
import {
  getDefaultHookWorkspaceRepos,
  type WorkspaceRepo,
} from "@/lib/workspace-repos";

function labelFromId(id: string): string {
  return id
    .split(/[._/-]+/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function patternForIntegration(integrationId: string): string {
  return `tools.${integrationId}.*`;
}

function repoCatalogItemFromWorkspaceRepo(
  repo: WorkspaceRepo,
  description: string,
): AutomationRepoCatalogItem {
  const fullName = `${repo.owner}/${repo.repo}`;
  return {
    id: fullName,
    owner: repo.owner,
    name: repo.repo,
    fullName,
    private: false,
    description,
    cloneUrl: repo.cloneUrl,
    branch: repo.branch,
  };
}

function mergeRepoCatalogItems(
  repos: AutomationRepoCatalogItem[],
): AutomationRepoCatalogItem[] {
  const byFullName = new Map<string, AutomationRepoCatalogItem>();
  for (const repo of repos) {
    const existing = byFullName.get(repo.fullName);
    byFullName.set(repo.fullName, existing ? { ...repo, ...existing } : repo);
  }
  return Array.from(byFullName.values()).sort((left, right) =>
    left.fullName.localeCompare(right.fullName),
  );
}

function fallbackOwnersFromRepos(
  repos: AutomationRepoCatalogItem[],
): AutomationRepoOwnerCatalogItem[] {
  return Array.from(new Set(repos.map((repo) => repo.owner))).map((owner) => ({
    id: owner,
    label: owner,
    accountType: "Organization" as const,
    installationId: 0,
    repositorySelection: "selected" as const,
  }));
}

function mergeRepoOwners(
  owners: AutomationRepoOwnerCatalogItem[],
): AutomationRepoOwnerCatalogItem[] {
  const byId = new Map<string, AutomationRepoOwnerCatalogItem>();
  for (const owner of owners) {
    byId.set(owner.id, byId.get(owner.id) ?? owner);
  }
  return Array.from(byId.values()).sort((left, right) =>
    left.label.localeCompare(right.label),
  );
}

async function listExecutorCatalog(userId: string): Promise<{
  sources: AutomationExecutorSourceCatalogItem[];
  tools: AutomationExecutorToolCatalogItem[];
}> {
  const executor = await createOpenAgentsExecutor({ userId });
  const [integrations, rawTools] = await Promise.all([
    Effect.runPromise(executor.integrations.list()),
    Effect.runPromise(executor.tools.list({ includeAnnotations: false })),
  ]);

  const tools = rawTools.map((tool): AutomationExecutorToolCatalogItem => {
    const id = String(tool.address);
    const integrationId = String(tool.integration);
    const label = String(tool.name);

    return {
      id,
      label,
      description: tool.description,
      sourceId: integrationId,
      pattern: id,
      group: labelFromId(integrationId),
    };
  });

  const toolCounts = new Map<string, number>();
  for (const tool of tools) {
    if (!tool.sourceId) continue;
    toolCounts.set(tool.sourceId, (toolCounts.get(tool.sourceId) ?? 0) + 1);
  }

  const sources = integrations.map((integration): AutomationExecutorSourceCatalogItem => {
    const id = String(integration.slug);
    const label = integration.name ?? labelFromId(id);

    return {
      id,
      label,
      description: integration.description ?? integration.kind,
      pattern: patternForIntegration(id),
      toolCount: toolCounts.get(id) ?? 0,
      badge: "integration",
    };
  });

  return { sources, tools };
}

async function listRepoCatalog(userId: string): Promise<{
  owners: AutomationRepoOwnerCatalogItem[];
  repos: AutomationRepoCatalogItem[];
}> {
  const installations = await getInstallationsByUserId(userId);
  const owners = installations.map((installation) => ({
    id: installation.accountLogin,
    label: installation.accountLogin,
    accountType: installation.accountType,
    installationId: installation.installationId,
    repositorySelection: installation.repositorySelection,
  }));

  const userToken = await getUserGitHubToken(userId);
  if (!userToken) {
    return { owners, repos: [] };
  }

  const reposByInstallation = await Promise.all(
    installations.slice(0, 6).map(async (installation) => {
      try {
        return await listUserInstallationRepositories({
          installationId: installation.installationId,
          userToken,
          owner: installation.accountLogin,
          limit: 25,
        });
      } catch (error) {
        console.error(
          `Failed to list repositories for ${installation.accountLogin}:`,
          error,
        );
        return [];
      }
    }),
  );

  const repos = reposByInstallation.flat().map((repo) => {
    const [owner = "", name = repo.name] = repo.full_name.split("/", 2);
    return {
      id: repo.full_name,
      owner,
      name,
      fullName: repo.full_name,
      private: repo.private,
      description: repo.description,
      cloneUrl: repo.clone_url,
      updatedAt: repo.updated_at,
    };
  });

  return { owners, repos };
}

async function optionalCatalogPart<T>(
  promise: Promise<T>,
  onError: (error: unknown) => T,
): Promise<T> {
  try {
    return await promise;
  } catch (error) {
    return onError(error);
  }
}

export async function GET() {
  const session = await getServerSession();
  if (!session?.user?.id) {
    return Response.json({ error: "Not authenticated" }, { status: 401 });
  }

  const errors: string[] = [];
  const [preferences, library, executorCatalog, repoCatalog] = await Promise.all([
    getUserPreferences(session.user.id),
    listAgentLibrary(null, session.user.id),
    optionalCatalogPart(listExecutorCatalog(session.user.id), (error) => {
      errors.push(
        `Executor tools unavailable: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return { sources: [], tools: [] };
    }),
    optionalCatalogPart(listRepoCatalog(session.user.id), (error) => {
      errors.push(
        `Repositories unavailable: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return { owners: [], repos: [] };
    }),
  ]);

  const defaultAgentName = preferences.defaultAgentName;
  const configuredRepos = getDefaultHookWorkspaceRepos().map((repo) =>
    repoCatalogItemFromWorkspaceRepo(repo, "Configured workspace repository"),
  );
  const agentRepos = library.agents.flatMap((agent) =>
    agent.repos.map((repo) =>
      repoCatalogItemFromWorkspaceRepo(repo, `Repository mounted by ${agent.name}`),
    ),
  );
  const repos = mergeRepoCatalogItems([
    ...configuredRepos,
    ...agentRepos,
    ...repoCatalog.repos,
  ]);
  const repoOwners = mergeRepoOwners([
    ...fallbackOwnersFromRepos([...configuredRepos, ...agentRepos]),
    ...repoCatalog.owners,
  ]);
  const response: AutomationBuilderCatalog = {
    ...EMPTY_AUTOMATION_BUILDER_CATALOG,
    agents: automationAgentsToCatalogItems(library.agents, defaultAgentName),
    skills: automationSkillsToCatalogItems(library.skills),
    executorSources: executorCatalog.sources,
    executorTools: executorCatalog.tools,
    repoOwners,
    repos,
    defaultAgentName,
    errors,
  };

  return Response.json({ catalog: response });
}
