import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("server-only", () => ({}));

class TestAuthzError extends Error {
  readonly status: number;

  constructor(message: string, status = 403) {
    super(message);
    this.name = "AuthzError";
    this.status = status;
  }
}

type TestActor = { kind: "user"; userId: string };
type TestScope = { scopeKind: "user" | "group" | "org"; scopeId: string };
type TestVerb = "read" | "write" | "manage" | "admin";

const canAccessMock = mock(async (_actor: TestActor, _scope: TestScope, _verb: TestVerb) => true);
const resolveMembershipMock = mock(async (_actor: TestActor) => ({
  orgIds: new Set<string>(),
  groupIds: new Set<string>(),
  adminOrgIds: new Set<string>(),
  managerGroupIds: new Set<string>(),
}));

mock.module("@open-agents/authz", () => ({
  AuthzError: TestAuthzError,
  canAccess: canAccessMock,
  resolveMembership: resolveMembershipMock,
}));

type AutomationRow = {
  id: string;
  currentVersionId: string | null;
  scopeKind: "user" | "group" | "org";
  scopeId: string;
  ownerKind: "user" | "app-bot" | "service-account";
  ownerId: string;
  name: string;
  description: string | null;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
};

type VersionRow = {
  id: string;
  automationId: string;
  version: number;
  definitionJson: ReturnType<typeof automationDefinition>;
  definitionHash: string;
  createdBy: string;
  createdAt: Date;
  changeSummary: string | undefined;
};

type InsertCall = {
  tableName: string;
  values: Record<string, unknown>;
};

const tableNameSymbol = Symbol.for("drizzle:Name");
const insertCalls: InsertCall[] = [];
let automationRows: AutomationRow[] = [];
let versionRows: VersionRow[] = [];
let groupRows: Array<{ id: string; orgId: string }> = [];
let maxVersion = 0;
let findAutomationResult: AutomationRow | undefined;

function tableName(table: unknown): string {
  return (table as Record<symbol, string>)[tableNameSymbol];
}

function queryResult<T>(rows: T[]): Promise<T[]> & {
  orderBy: (...args: unknown[]) => Promise<T[]>;
  limit: (...args: unknown[]) => Promise<T[]>;
  groupBy: (...args: unknown[]) => Promise<T[]>;
} {
  const promise = Promise.resolve(rows) as Promise<T[]> & {
    orderBy: (...args: unknown[]) => Promise<T[]>;
    limit: (...args: unknown[]) => Promise<T[]>;
    groupBy: (...args: unknown[]) => Promise<T[]>;
  };
  promise.orderBy = async () => rows;
  promise.limit = async () => rows;
  promise.groupBy = async () => rows;
  return promise;
}

function selectRows(selection: unknown, table: unknown): unknown[] {
  const name = tableName(table);
  if (name === "automation_definitions") {
    return automationRows;
  }
  if (name === "automation_versions") {
    if (selection && typeof selection === "object" && "maxVersion" in selection) {
      return [{ maxVersion }];
    }
    return versionRows;
  }
  if (name === "automation_runs") {
    return [];
  }
  if (name === "groups") {
    return groupRows;
  }
  return [];
}

function selectBuilder(selection?: unknown) {
  return {
    from: (table: unknown) => {
      const rows = selectRows(selection, table);
      return {
        where: () => queryResult(rows),
        orderBy: async () => rows,
      };
    },
  };
}

function insertBuilder(table: unknown) {
  const name = tableName(table);
  return {
    values: (values: Record<string, unknown>) => {
      insertCalls.push({ tableName: name, values });
      return {
        onConflictDoUpdate: () => ({
          returning: async () => [
            {
              id: values.id,
              currentVersionId: values.currentVersionId,
              scopeKind: values.scopeKind,
              scopeId: values.scopeId,
              ownerKind: values.ownerKind,
              ownerId: values.ownerId,
              name: values.name,
              description: values.description ?? null,
              enabled: values.enabled,
              createdAt: values.createdAt,
              updatedAt: values.updatedAt,
            },
          ],
        }),
        returning: async () => [
          {
            id: values.id,
            automationId: values.automationId,
            version: values.version,
            definitionJson: values.definitionJson,
            definitionHash: values.definitionHash,
            createdBy: values.createdBy,
            createdAt: new Date(),
            changeSummary: values.changeSummary,
          },
        ],
      };
    },
  };
}

const dbMock = {
  query: {
    automationDefinitions: {
      findFirst: mock(async () => findAutomationResult),
    },
    automationVersions: {
      findFirst: mock(async () => versionRows[0]),
    },
  },
  select: mock(selectBuilder),
  selectDistinctOn: mock(() => selectBuilder()),
  insert: mock(insertBuilder),
  transaction: mock(async (callback: (tx: { insert: typeof insertBuilder }) => unknown) =>
    callback({ insert: insertBuilder }),
  ),
};

mock.module("@/lib/db/client", () => ({ db: dbMock }));
mock.module("@/lib/agents/repository", () => ({
  getAgentDefinition: mock(async () => null),
  listLocalSkillFilesForPatterns: mock(async () => []),
}));
mock.module("@/lib/db/sessions", () => ({
  getIsEveChatStreaming: mock(async () => false),
}));

const store = await import("./store");

function automationDefinition(overrides: Record<string, unknown> = {}) {
  return {
    id: "automation-1",
    name: "Test automation",
    enabled: true,
    scope: { kind: "user" as const, id: "user-1" },
    owner: { kind: "user" as const, id: "user-1" },
    identity: { kind: "user" as const, userId: "user-1" },
    triggers: [{ kind: "manual" as const }],
    conditions: [],
    concurrency: { key: "correlation" as const, onConflict: "queue" as const },
    correlation: { key: "correlation" as const },
    policy: {
      autonomy: "read-only" as const,
      budget: {},
      executorTools: [],
      builtInTools: [],
      memory: "none" as const,
      approvals: [],
    },
    action: {
      kind: "notify" as const,
      destination: "inbox" as const,
      message: "hello",
    },
    outputs: [{ kind: "inbox" }],
    ...overrides,
  };
}

function automationRow(overrides: Partial<AutomationRow> = {}): AutomationRow {
  const now = new Date("2026-01-01T00:00:00.000Z");
  return {
    id: "automation-1",
    currentVersionId: "version-1",
    scopeKind: "user",
    scopeId: "user-1",
    ownerKind: "user",
    ownerId: "user-1",
    name: "Test automation",
    description: null,
    enabled: true,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function versionRow(overrides: Partial<VersionRow> = {}): VersionRow {
  return {
    id: "version-1",
    automationId: "automation-1",
    version: 1,
    definitionJson: automationDefinition(),
    definitionHash: "hash",
    createdBy: "user-1",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    changeSummary: undefined,
    ...overrides,
  };
}

beforeEach(() => {
  canAccessMock.mockReset();
  canAccessMock.mockImplementation(async (_actor, _scope, _verb) => true);
  resolveMembershipMock.mockReset();
  resolveMembershipMock.mockImplementation(async (_actor) => ({
    orgIds: new Set<string>(),
    groupIds: new Set<string>(),
    adminOrgIds: new Set<string>(),
    managerGroupIds: new Set<string>(),
  }));
  dbMock.query.automationDefinitions.findFirst.mockReset();
  dbMock.query.automationDefinitions.findFirst.mockImplementation(async () => findAutomationResult);
  dbMock.query.automationVersions.findFirst.mockReset();
  dbMock.query.automationVersions.findFirst.mockImplementation(async () => versionRows[0]);
  dbMock.select.mockReset();
  dbMock.select.mockImplementation(selectBuilder);
  dbMock.selectDistinctOn.mockReset();
  dbMock.selectDistinctOn.mockImplementation(() => selectBuilder());
  dbMock.insert.mockReset();
  dbMock.insert.mockImplementation(insertBuilder);
  dbMock.transaction.mockReset();
  dbMock.transaction.mockImplementation(async (callback) => callback({ insert: insertBuilder }));
  insertCalls.length = 0;
  automationRows = [];
  versionRows = [];
  groupRows = [];
  maxVersion = 0;
  findAutomationResult = undefined;
});

describe("automation store authorization", () => {
  test("rejects creating org-scoped automations without manage access", async () => {
    canAccessMock.mockImplementation(async (_actor, _scope, _verb) => false);

    await expect(
      store.upsertAutomationDefinition({
        userId: "user-member",
        definition: automationDefinition({
          scope: { kind: "org", id: "org-goaugment" },
          owner: { kind: "user", id: "user-member" },
          identity: { kind: "user", userId: "user-member" },
        }),
      }),
    ).rejects.toMatchObject({ name: "AuthzError", status: 403 });

    expect(canAccessMock).toHaveBeenCalledWith(
      { kind: "user", userId: "user-member" },
      { scopeKind: "org", scopeId: "org-goaugment" },
      "manage",
    );
    expect(insertCalls).toHaveLength(0);
  });

  test("rejects owner updates when the user cannot manage the existing automation scope", async () => {
    findAutomationResult = automationRow({
      scopeKind: "group",
      scopeId: "group-managed-by-someone-else",
      ownerId: "user-owner",
    });
    canAccessMock.mockImplementation(
      async (_actor, scope, _verb) => scope.scopeId !== "group-managed-by-someone-else",
    );

    await expect(
      store.upsertAutomationDefinition({
        userId: "user-owner",
        definition: automationDefinition({
          scope: { kind: "group", id: "group-managed-by-someone-else" },
          owner: { kind: "user", id: "user-owner" },
          identity: { kind: "user", userId: "user-owner" },
        }),
      }),
    ).rejects.toMatchObject({ name: "AuthzError", status: 403 });

    expect(canAccessMock).toHaveBeenCalledWith(
      { kind: "user", userId: "user-owner" },
      { scopeKind: "group", scopeId: "group-managed-by-someone-else" },
      "manage",
    );
    expect(insertCalls).toHaveLength(0);
  });

  test("stores group-scoped automations only after manage access succeeds", async () => {
    maxVersion = 2;

    const saved = await store.upsertAutomationDefinition({
      userId: "group-manager",
      definition: automationDefinition({
        scope: { kind: "group", id: "group-a" },
        owner: { kind: "user", id: "group-manager" },
        identity: { kind: "user", userId: "group-manager" },
      }),
      changeSummary: "managed group automation",
    });

    expect(saved.automation).toMatchObject({
      scopeKind: "group",
      scopeId: "group-a",
      ownerKind: "user",
      ownerId: "group-manager",
    });
    expect(saved.version).toMatchObject({ version: 3, createdBy: "group-manager" });
    expect(canAccessMock).toHaveBeenCalledWith(
      { kind: "user", userId: "group-manager" },
      { scopeKind: "group", scopeId: "group-a" },
      "manage",
    );
  });

  test("uses authz read checks for direct automation reads", async () => {
    automationRows = [
      automationRow({
        scopeKind: "org",
        scopeId: "org-a",
        ownerId: "different-owner",
      }),
    ];
    canAccessMock.mockImplementation(async (_actor, _scope, _verb) => false);

    await expect(
      store.getAutomationForUser({ automationId: "automation-1", userId: "user-member" }),
    ).resolves.toBeNull();

    expect(canAccessMock).toHaveBeenCalledWith(
      { kind: "user", userId: "user-member" },
      { scopeKind: "org", scopeId: "org-a" },
      "read",
    );
  });

  test("lists readable non-owner group and org automations from membership scopes", async () => {
    resolveMembershipMock.mockImplementation(async (_actor) => ({
      orgIds: new Set(["org-a"]),
      groupIds: new Set(["group-a"]),
      adminOrgIds: new Set(["org-admin"]),
      managerGroupIds: new Set(["group-managed"]),
    }));
    groupRows = [{ id: "group-from-admin-org", orgId: "org-admin" }];
    automationRows = [
      automationRow({ id: "owned-by-scope-user", scopeKind: "user", scopeId: "user-member" }),
      automationRow({
        id: "group-visible",
        scopeKind: "group",
        scopeId: "group-a",
        ownerId: "different-owner",
      }),
      automationRow({
        id: "org-visible",
        scopeKind: "org",
        scopeId: "org-a",
        ownerId: "different-owner",
      }),
    ];
    versionRows = automationRows.map((row) =>
      versionRow({
        id: `${row.id}-version`,
        automationId: row.id,
        definitionJson: automationDefinition({
          id: row.id,
          scope: { kind: row.scopeKind, id: row.scopeId },
        }),
      }),
    );

    const automations = await store.listAutomationsForUser("user-member");

    expect(resolveMembershipMock).toHaveBeenCalledWith({ kind: "user", userId: "user-member" });
    expect(automations.map((automation) => automation.id)).toEqual([
      "owned-by-scope-user",
      "group-visible",
      "org-visible",
    ]);
  });
});
