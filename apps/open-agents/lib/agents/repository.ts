import "server-only";

import { promises as fs } from "node:fs";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { parse, stringify } from "yaml";
import {
  agentEditorInputSchema,
  agentFrontmatterSchema,
  type AgentDefinition,
  type AgentEditorInput,
  type AgentLibraryItemScope,
  type AgentLibrarySaveScope,
  type AgentLibrarySummary,
  type SkillDocument,
  type SkillEditorInput,
  skillEditorInputSchema,
} from "./definitions";
import { db } from "@/lib/db/client";
import { agentLibraryItems } from "@/lib/db/schema";

const AGENTS_ROOT_ENV = "OPEN_AGENTS_LIBRARY_ROOT";
const WORKSPACE_ROOT_MARKERS = ["package.json", "README.md"];
const AGENT_SLUG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const SAFE_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

type MarkdownParts = {
  frontmatter: Record<string, unknown>;
  body: string;
};

type AgentLibraryKind = "agent" | "skill";
type DatabaseAgentLibraryScope = Exclude<AgentLibraryItemScope, "bundled">;

const DEFAULT_ORG_SCOPE_ID = "default";

function getAgentLibraryOrgScopeId(): string {
  return process.env.OPEN_AGENTS_ORG_SCOPE_ID?.trim() || DEFAULT_ORG_SCOPE_ID;
}

type AgentLibraryRow = typeof agentLibraryItems.$inferSelect;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
}

async function isWorkspaceRoot(candidate: string): Promise<boolean> {
  for (const marker of WORKSPACE_ROOT_MARKERS) {
    if (!(await pathExists(path.join(candidate, marker)))) {
      return false;
    }
  }

  return pathExists(path.join(candidate, "apps", "open-agents"));
}

async function findWorkspaceRoot(): Promise<string> {
  if (process.env[AGENTS_ROOT_ENV]) {
    return path.resolve(process.env[AGENTS_ROOT_ENV]);
  }

  let current = process.cwd();
  while (true) {
    if (await isWorkspaceRoot(current)) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return process.cwd();
    }
    current = parent;
  }
}

export async function getAgentsLibraryRoot(): Promise<string> {
  return path.join(await findWorkspaceRoot(), ".agents");
}

async function getAgentsDirectory(): Promise<string> {
  return path.join(await getAgentsLibraryRoot(), "agents");
}

async function getSkillsDirectory(): Promise<string> {
  return path.join(await getAgentsLibraryRoot(), "skills");
}

function assertAgentSlug(slug: string): string {
  const normalized = slug.trim();
  if (!AGENT_SLUG_PATTERN.test(normalized)) {
    throw new Error("Agent slug must use letters, numbers, underscores, or dashes.");
  }
  return normalized;
}

function normalizeSkillId(id: string): string {
  const segments = id
    .trim()
    .replace(/\\/g, "/")
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);

  if (segments.length === 0 || segments.some((segment) => !SAFE_SEGMENT_PATTERN.test(segment))) {
    throw new Error("Skill path must use safe folder names separated by slashes.");
  }

  return segments.join("/");
}

function assertInside(base: string, target: string): void {
  const relative = path.relative(base, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Resolved path escapes the agents library.");
  }
}

function parseMarkdownDocument(content: string): MarkdownParts {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) {
    return { frontmatter: {}, body: content };
  }

  const parsedFrontmatter = parse(match[1] ?? "");
  return {
    frontmatter: isRecord(parsedFrontmatter) ? parsedFrontmatter : {},
    body: content.slice(match[0].length),
  };
}

function serializeMarkdownDocument(frontmatter: Record<string, unknown>, body: string): string {
  const frontmatterText = stringify(frontmatter).trimEnd();
  return `---\n${frontmatterText}\n---\n\n${body.trimStart()}`;
}

function toAgentDefinition(
  slug: string,
  filePath: string,
  content: string,
): AgentDefinition | null {
  const { frontmatter, body } = parseMarkdownDocument(content);
  const parsed = agentFrontmatterSchema.safeParse(frontmatter);
  if (!parsed.success) {
    return null;
  }

  return {
    slug,
    name: parsed.data.name,
    description: parsed.data.description,
    tools: parsed.data.tools,
    repos: parsed.data.repos,
    skills: parsed.data.skills,
    model: parsed.data.model,
    systemPrompt: body.trimStart(),
    path: filePath,
    scope: "bundled",
  };
}

function parseBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function parseStringArray(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const values = value.filter((item): item is string => typeof item === "string");
    return values.length > 0 ? values : undefined;
  }
  if (typeof value === "string") {
    const values = value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    return values.length > 0 ? values : undefined;
  }
  return undefined;
}

function toSkillDocument(id: string, filePath: string, content: string): SkillDocument | null {
  const { frontmatter, body } = parseMarkdownDocument(content);
  const name = typeof frontmatter.name === "string" ? frontmatter.name.trim() : "";
  const description =
    typeof frontmatter.description === "string" ? frontmatter.description.trim() : "";

  if (!name || !description) {
    return null;
  }

  const context = frontmatter.context === "fork" ? "fork" : undefined;
  const agent = typeof frontmatter.agent === "string" ? frontmatter.agent.trim() : undefined;

  return {
    id,
    name,
    description,
    body: body.trimStart(),
    path: filePath,
    scope: "bundled",
    userInvocable: parseBoolean(frontmatter["user-invocable"]),
    disableModelInvocation: parseBoolean(frontmatter["disable-model-invocation"]),
    allowedTools: parseStringArray(frontmatter["allowed-tools"]),
    context,
    agent: agent || undefined,
  };
}

function agentFromEditorInput(
  input: AgentEditorInput,
  itemPath: string,
  scope: AgentLibraryItemScope,
): AgentDefinition {
  return {
    slug: input.slug,
    name: input.name,
    description: input.description,
    tools: input.tools,
    repos: input.repos,
    skills: input.skills,
    model: input.model,
    systemPrompt: input.systemPrompt,
    path: itemPath,
    scope,
  };
}

function skillFromEditorInput(
  input: SkillEditorInput,
  itemPath: string,
  scope: AgentLibraryItemScope,
): SkillDocument {
  return {
    id: input.id,
    name: input.name,
    description: input.description,
    body: input.body,
    path: itemPath,
    scope,
    userInvocable: input.userInvocable,
    disableModelInvocation: input.disableModelInvocation,
    allowedTools: input.allowedTools,
    context: input.context,
    agent: input.agent,
  };
}

function dbItemPath(kind: AgentLibraryKind, itemId: string, scope: DatabaseAgentLibraryScope): string {
  return `db:${scope}:${kind}:${itemId}`;
}

function toDatabaseAgent(row: AgentLibraryRow): AgentDefinition | null {
  const parsed = agentEditorInputSchema.safeParse(row.itemJson);
  return parsed.success
    ? agentFromEditorInput(
        parsed.data,
        dbItemPath("agent", row.itemId, row.scopeKind),
        row.scopeKind,
      )
    : null;
}

function toDatabaseSkill(row: AgentLibraryRow): SkillDocument | null {
  const parsed = skillEditorInputSchema.safeParse(row.itemJson);
  return parsed.success
    ? skillFromEditorInput(
        parsed.data,
        dbItemPath("skill", row.itemId, row.scopeKind),
        row.scopeKind,
      )
    : null;
}

function isDatabaseBackedPath(itemPath: string): boolean {
  return itemPath.startsWith("db:");
}

function databaseScopeForSave(userId: string, scope: AgentLibrarySaveScope) {
  return {
    kind: scope,
    id: scope === "user" ? userId : getAgentLibraryOrgScopeId(),
  } as const;
}

function databaseScopesForRead(userId?: string) {
  return [
    { kind: "org", id: getAgentLibraryOrgScopeId() } as const,
    ...(userId ? ([{ kind: "user", id: userId } as const] as const) : []),
  ];
}

async function listDatabaseItems(
  scope: { kind: DatabaseAgentLibraryScope; id: string },
  kind: AgentLibraryKind,
): Promise<AgentLibraryRow[]> {
  return db
    .select()
    .from(agentLibraryItems)
    .where(
      and(
        eq(agentLibraryItems.scopeKind, scope.kind),
        eq(agentLibraryItems.scopeId, scope.id),
        eq(agentLibraryItems.kind, kind),
      ),
    );
}

async function getDatabaseItem(
  scope: { kind: DatabaseAgentLibraryScope; id: string },
  kind: AgentLibraryKind,
  itemId: string,
): Promise<AgentLibraryRow | null> {
  const [row] = await db
    .select()
    .from(agentLibraryItems)
    .where(
      and(
        eq(agentLibraryItems.scopeKind, scope.kind),
        eq(agentLibraryItems.scopeId, scope.id),
        eq(agentLibraryItems.kind, kind),
        eq(agentLibraryItems.itemId, itemId),
      ),
    )
    .limit(1);
  return row ?? null;
}

async function saveDatabaseItem(params: {
  userId: string;
  scopeKind: AgentLibrarySaveScope;
  scopeId: string;
  kind: AgentLibraryKind;
  itemId: string;
  itemJson: Record<string, unknown>;
}): Promise<void> {
  await db
    .insert(agentLibraryItems)
    .values({
      id: nanoid(),
      userId: params.userId,
      scopeKind: params.scopeKind,
      scopeId: params.scopeId,
      kind: params.kind,
      itemId: params.itemId,
      itemJson: params.itemJson,
    })
    .onConflictDoUpdate({
      target: [
        agentLibraryItems.scopeKind,
        agentLibraryItems.scopeId,
        agentLibraryItems.kind,
        agentLibraryItems.itemId,
      ],
      set: {
        userId: params.userId,
        itemJson: params.itemJson,
        updatedAt: new Date(),
      },
    });
}

async function deleteDatabaseItem(
  scope: { kind: DatabaseAgentLibraryScope; id: string },
  kind: AgentLibraryKind,
  itemId: string,
): Promise<void> {
  await db
    .delete(agentLibraryItems)
    .where(
      and(
        eq(agentLibraryItems.scopeKind, scope.kind),
        eq(agentLibraryItems.scopeId, scope.id),
        eq(agentLibraryItems.kind, kind),
        eq(agentLibraryItems.itemId, itemId),
      ),
    );
}

async function listMarkdownFiles(directory: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => path.join(directory, entry.name));
  } catch {
    return [];
  }
}

async function listSkillFiles(
  directory: string,
  prefix = "",
): Promise<Array<{ id: string; filePath: string }>> {
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }

  const skillFile = entries.find(
    (entry) => entry.isFile() && (entry.name === "SKILL.md" || entry.name === "skill.md"),
  );
  if (skillFile && prefix) {
    return [{ id: prefix, filePath: path.join(directory, skillFile.name) }];
  }

  const nested = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map((entry) =>
        listSkillFiles(
          path.join(directory, entry.name),
          prefix ? `${prefix}/${entry.name}` : entry.name,
        ),
      ),
  );
  return nested.flat();
}

export async function listAgentDefinitions(userId?: string): Promise<AgentDefinition[]> {
  const agentsDir = await getAgentsDirectory();
  const files = await listMarkdownFiles(agentsDir);
  const bundledAgents = await Promise.all(
    files.map(async (filePath) => {
      const slug = path.basename(filePath, ".md");
      const content = await fs.readFile(filePath, "utf-8");
      return toAgentDefinition(slug, filePath, content);
    }),
  );

  const bySlug = new Map<string, AgentDefinition>();
  for (const agent of bundledAgents) {
    if (agent) {
      bySlug.set(agent.slug, agent);
    }
  }

  for (const scope of databaseScopesForRead(userId)) {
    const databaseAgents = await listDatabaseItems(scope, "agent");
    for (const row of databaseAgents) {
      const agent = toDatabaseAgent(row);
      if (agent) {
        bySlug.set(agent.slug, agent);
      }
    }
  }

  return Array.from(bySlug.values()).sort((left, right) => left.name.localeCompare(right.name));
}

export async function getAgentDefinition(
  slug: string,
  userId?: string,
): Promise<AgentDefinition | null> {
  const normalizedSlug = assertAgentSlug(slug);

  for (const scope of [...databaseScopesForRead(userId)].reverse()) {
    const row = await getDatabaseItem(scope, "agent", normalizedSlug);
    const databaseAgent = row ? toDatabaseAgent(row) : null;
    if (databaseAgent) {
      return databaseAgent;
    }
  }

  const agentsDir = await getAgentsDirectory();
  const filePath = path.join(agentsDir, `${normalizedSlug}.md`);
  assertInside(agentsDir, filePath);

  try {
    const content = await fs.readFile(filePath, "utf-8");
    return toAgentDefinition(normalizedSlug, filePath, content);
  } catch {
    return null;
  }
}

export async function saveAgentDefinition(
  input: AgentEditorInput,
  userId?: string,
  scope: AgentLibrarySaveScope = "user",
): Promise<AgentDefinition> {
  const parsed = agentEditorInputSchema.parse(input);
  const slug = assertAgentSlug(parsed.slug);

  if (userId) {
    const databaseScope = databaseScopeForSave(userId, scope);
    await saveDatabaseItem({
      userId,
      scopeKind: databaseScope.kind,
      scopeId: databaseScope.id,
      kind: "agent",
      itemId: slug,
      itemJson: parsed as unknown as Record<string, unknown>,
    });
    return agentFromEditorInput(parsed, dbItemPath("agent", slug, databaseScope.kind), scope);
  }

  const agentsDir = await getAgentsDirectory();
  const filePath = path.join(agentsDir, `${slug}.md`);
  assertInside(agentsDir, filePath);

  await fs.mkdir(agentsDir, { recursive: true });
  const content = serializeMarkdownDocument(
    {
      name: parsed.name,
      description: parsed.description,
      ...(parsed.tools.length > 0 ? { tools: parsed.tools } : {}),
      ...(parsed.repos.length > 0 ? { repos: parsed.repos } : {}),
      ...(parsed.skills.length > 0 ? { skills: parsed.skills } : {}),
      ...(parsed.model ? { model: parsed.model } : {}),
    },
    parsed.systemPrompt,
  );
  await fs.writeFile(filePath, content, "utf-8");

  const agent = toAgentDefinition(slug, filePath, content);
  if (!agent) {
    throw new Error("Saved agent could not be parsed.");
  }
  return agent;
}

export async function deleteAgentDefinition(
  slug: string,
  userId?: string,
  scope: AgentLibrarySaveScope = "user",
): Promise<void> {
  const normalizedSlug = assertAgentSlug(slug);

  if (userId) {
    await deleteDatabaseItem(databaseScopeForSave(userId, scope), "agent", normalizedSlug);
    return;
  }

  const agentsDir = await getAgentsDirectory();
  const filePath = path.join(agentsDir, `${normalizedSlug}.md`);
  assertInside(agentsDir, filePath);
  await fs.rm(filePath, { force: true });
}

export async function listSkillDocuments(userId?: string): Promise<SkillDocument[]> {
  const skillsDir = await getSkillsDirectory();
  const files = await listSkillFiles(skillsDir);
  const bundledSkills = await Promise.all(
    files.map(async ({ id, filePath }) => {
      const content = await fs.readFile(filePath, "utf-8");
      return toSkillDocument(id, filePath, content);
    }),
  );

  const byId = new Map<string, SkillDocument>();
  for (const skill of bundledSkills) {
    if (skill) {
      byId.set(skill.id, skill);
    }
  }

  for (const scope of databaseScopesForRead(userId)) {
    const databaseSkills = await listDatabaseItems(scope, "skill");
    for (const row of databaseSkills) {
      const skill = toDatabaseSkill(row);
      if (skill) {
        byId.set(skill.id, skill);
      }
    }
  }

  return Array.from(byId.values()).sort((left, right) => left.id.localeCompare(right.id));
}

export async function getSkillDocument(
  id: string,
  userId?: string,
): Promise<SkillDocument | null> {
  const skillId = normalizeSkillId(id);

  for (const scope of [...databaseScopesForRead(userId)].reverse()) {
    const row = await getDatabaseItem(scope, "skill", skillId);
    const databaseSkill = row ? toDatabaseSkill(row) : null;
    if (databaseSkill) {
      return databaseSkill;
    }
  }

  const skillsDir = await getSkillsDirectory();
  const filePath = path.join(skillsDir, skillId, "SKILL.md");
  assertInside(skillsDir, filePath);

  try {
    const content = await fs.readFile(filePath, "utf-8");
    return toSkillDocument(skillId, filePath, content);
  } catch {
    return null;
  }
}

export async function saveSkillDocument(
  input: SkillEditorInput,
  userId?: string,
  scope: AgentLibrarySaveScope = "user",
): Promise<SkillDocument> {
  const parsed = skillEditorInputSchema.parse(input);
  const skillId = normalizeSkillId(parsed.id);
  const normalized = { ...parsed, id: skillId };

  if (userId) {
    const databaseScope = databaseScopeForSave(userId, scope);
    await saveDatabaseItem({
      userId,
      scopeKind: databaseScope.kind,
      scopeId: databaseScope.id,
      kind: "skill",
      itemId: skillId,
      itemJson: normalized as unknown as Record<string, unknown>,
    });
    return skillFromEditorInput(normalized, dbItemPath("skill", skillId, databaseScope.kind), scope);
  }

  const skillsDir = await getSkillsDirectory();
  const skillDir = path.join(skillsDir, skillId);
  const filePath = path.join(skillDir, "SKILL.md");
  assertInside(skillsDir, filePath);

  await fs.mkdir(skillDir, { recursive: true });
  const content = serializeMarkdownDocument(
    {
      name: parsed.name,
      description: parsed.description,
      ...(parsed.userInvocable !== undefined ? { "user-invocable": parsed.userInvocable } : {}),
      ...(parsed.disableModelInvocation !== undefined
        ? { "disable-model-invocation": parsed.disableModelInvocation }
        : {}),
      ...(parsed.allowedTools.length > 0 ? { "allowed-tools": parsed.allowedTools } : {}),
      ...(parsed.context ? { context: parsed.context } : {}),
      ...(parsed.agent ? { agent: parsed.agent } : {}),
    },
    parsed.body,
  );
  await fs.writeFile(filePath, content, "utf-8");

  const skill = toSkillDocument(skillId, filePath, content);
  if (!skill) {
    throw new Error("Saved skill could not be parsed.");
  }
  return skill;
}

export async function deleteSkillDocument(
  id: string,
  userId?: string,
  scope: AgentLibrarySaveScope = "user",
): Promise<void> {
  const skillId = normalizeSkillId(id);

  if (userId) {
    await deleteDatabaseItem(databaseScopeForSave(userId, scope), "skill", skillId);
    return;
  }

  const skillsDir = await getSkillsDirectory();
  const skillDir = path.join(skillsDir, skillId);
  assertInside(skillsDir, skillDir);
  await fs.rm(skillDir, { recursive: true, force: true });
}

export function agentDefinitionToEditorInput(agent: AgentDefinition): AgentEditorInput {
  return {
    slug: agent.slug,
    name: agent.name,
    description: agent.description,
    tools: agent.tools,
    repos: agent.repos,
    skills: agent.skills,
    model: agent.model,
    systemPrompt: agent.systemPrompt,
  };
}

export function skillDocumentToEditorInput(skill: SkillDocument): SkillEditorInput {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    body: skill.body,
    userInvocable: skill.userInvocable,
    disableModelInvocation: skill.disableModelInvocation,
    allowedTools: skill.allowedTools ?? [],
    context: skill.context,
    agent: skill.agent,
  };
}

function skillDocumentToMarkdown(skill: SkillDocument): string {
  return serializeMarkdownDocument(
    {
      name: skill.name,
      description: skill.description,
      ...(skill.userInvocable !== undefined ? { "user-invocable": skill.userInvocable } : {}),
      ...(skill.disableModelInvocation !== undefined
        ? { "disable-model-invocation": skill.disableModelInvocation }
        : {}),
      ...(skill.allowedTools && skill.allowedTools.length > 0
        ? { "allowed-tools": skill.allowedTools }
        : {}),
      ...(skill.context ? { context: skill.context } : {}),
      ...(skill.agent ? { agent: skill.agent } : {}),
    },
    skill.body,
  );
}

export async function listAgentLibrary(
  defaultAgentName: string | null,
  userId?: string,
): Promise<AgentLibrarySummary> {
  const [agents, skills] = await Promise.all([
    listAgentDefinitions(userId),
    listSkillDocuments(userId),
  ]);
  return {
    agents,
    skills,
    defaultAgentName:
      defaultAgentName && agents.some((agent) => agent.slug === defaultAgentName)
        ? defaultAgentName
        : null,
  };
}

export async function listLocalSkillFilesForPatterns(
  patterns: string[],
  userId?: string,
): Promise<
  Array<{
    skill: SkillDocument;
    files: Array<{ relativePath: string; content: string }>;
  }>
> {
  const skills = await listSkillDocuments(userId);
  const matchedSkills = filterSkillDocuments(skills, patterns);

  return Promise.all(
    matchedSkills.map(async (skill) => {
      if (isDatabaseBackedPath(skill.path)) {
        return {
          skill,
          files: [
            {
              relativePath: path.posix.join(skill.id, "SKILL.md"),
              content: skillDocumentToMarkdown(skill),
            },
          ],
        };
      }

      const skillRoot = path.dirname(skill.path);
      const files = await listFilesRecursively(skillRoot);
      return {
        skill,
        files: await Promise.all(
          files.map(async (filePath) => ({
            relativePath: path.posix.join(
              skill.id,
              path.relative(skillRoot, filePath).split(path.sep).join("/"),
            ),
            content: await fs.readFile(filePath, "utf-8"),
          })),
        ),
      };
    }),
  );
}

async function listFilesRecursively(directory: string): Promise<string[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        return listFilesRecursively(entryPath);
      }
      if (entry.isFile()) {
        return Promise.resolve([entryPath]);
      }
      return Promise.resolve([] as string[]);
    }),
  );
  return nested.flat();
}

export function matchesAgentPattern(pattern: string, candidates: string[]): boolean {
  const normalizedPattern = pattern.trim().toLowerCase();
  if (!normalizedPattern || normalizedPattern === "*") {
    return true;
  }

  return candidates.some((candidate) => {
    const normalizedCandidate = candidate.trim().toLowerCase();
    if (normalizedPattern.endsWith("/*")) {
      const prefix = normalizedPattern.slice(0, -2);
      return normalizedCandidate === prefix || normalizedCandidate.startsWith(`${prefix}/`);
    }
    if (normalizedPattern.endsWith(".*")) {
      const prefix = normalizedPattern.slice(0, -2);
      return normalizedCandidate === prefix || normalizedCandidate.startsWith(`${prefix}.`);
    }
    if (normalizedPattern.endsWith("*")) {
      return normalizedCandidate.startsWith(normalizedPattern.slice(0, -1));
    }
    return normalizedCandidate === normalizedPattern;
  });
}

export function filterSkillDocuments(skills: SkillDocument[], patterns: string[]): SkillDocument[] {
  if (patterns.length === 0) {
    return skills;
  }

  return skills.filter((skill) =>
    patterns.some((pattern) =>
      matchesAgentPattern(pattern, [skill.id, skill.name, path.posix.basename(skill.id)]),
    ),
  );
}
