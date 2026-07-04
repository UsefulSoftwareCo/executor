import { DurableObject } from "cloudflare:workers";
import { Data, Effect } from "effect";

export type McpExecutionOwnerRoute = {
  readonly sessionId: string;
};

export type McpExecutionOwnerRecord = {
  readonly executionId: string;
  readonly owner: McpExecutionOwnerRoute;
  readonly accountId: string;
  readonly organizationId: string;
  readonly expiresAt: string;
  readonly ttlMs: number;
};

export interface McpExecutionOwnerDirectory {
  readonly put: (record: McpExecutionOwnerRecord) => Effect.Effect<void, unknown>;
  readonly get: (executionId: string) => Effect.Effect<McpExecutionOwnerRecord | null, unknown>;
  readonly delete: (executionId: string) => Effect.Effect<void, unknown>;
}

export interface McpExecutionOwnerDirectoryStub {
  readonly put: (record: McpExecutionOwnerRecord) => Promise<void>;
  readonly get: (executionId: string) => Promise<McpExecutionOwnerRecord | null>;
  readonly delete: (executionId: string) => Promise<void>;
}

export interface McpExecutionOwnerDirectoryNamespace<Id> {
  readonly idFromName: (name: string) => Id;
  readonly get: (id: Id) => unknown;
}

type McpExecutionOwnerDirectoryStorage = DurableObjectState["storage"];

const toMcpExecutionOwnerDirectoryStub = (stub: unknown): McpExecutionOwnerDirectoryStub =>
  stub as McpExecutionOwnerDirectoryStub;

export const mcpSessionDurableObjectName = (sessionId: string): string =>
  `streamable-http:${sessionId}`;

class McpExecutionOwnerDirectoryRpcError extends Data.TaggedError(
  "McpExecutionOwnerDirectoryRpcError",
)<{
  readonly cause: unknown;
}> {}

const RECORD_KEY = "owner";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isOwnerRoute = (value: unknown): value is McpExecutionOwnerRoute =>
  isRecord(value) && typeof value.sessionId === "string";

const isOwnerRecord = (value: unknown): value is McpExecutionOwnerRecord =>
  isRecord(value) &&
  typeof value.executionId === "string" &&
  isOwnerRoute(value.owner) &&
  typeof value.accountId === "string" &&
  typeof value.organizationId === "string" &&
  typeof value.expiresAt === "string" &&
  typeof value.ttlMs === "number";

const expiryMs = (record: McpExecutionOwnerRecord): number => Date.parse(record.expiresAt);

export class McpExecutionOwnerDirectoryDO extends DurableObject<unknown> {
  private readonly storage: McpExecutionOwnerDirectoryStorage;

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    this.storage = ctx.storage;
  }

  async put(record: McpExecutionOwnerRecord): Promise<void> {
    const expiresAtMs = expiryMs(record);
    if (!Number.isFinite(expiresAtMs)) return;
    await this.storage.put(RECORD_KEY, record);
    await this.storage.setAlarm(expiresAtMs);
  }

  async get(executionId: string): Promise<McpExecutionOwnerRecord | null> {
    const stored = await this.storage.get<unknown>(RECORD_KEY);
    if (!isOwnerRecord(stored) || stored.executionId !== executionId) return null;
    const expiresAtMs = expiryMs(stored);
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
      await this.delete(executionId);
      return null;
    }
    return stored;
  }

  async delete(executionId: string): Promise<void> {
    const stored = await this.storage.get<unknown>(RECORD_KEY);
    if (isOwnerRecord(stored) && stored.executionId !== executionId) return;
    await Promise.all([this.storage.delete(RECORD_KEY), this.storage.deleteAlarm()]);
  }

  override async alarm(): Promise<void> {
    await Promise.all([this.storage.delete(RECORD_KEY), this.storage.deleteAlarm()]);
  }
}

export const mcpExecutionOwnerDirectoryFromNamespace = <Id>(
  namespace: McpExecutionOwnerDirectoryNamespace<Id> | undefined,
): McpExecutionOwnerDirectory | null => {
  if (!namespace) return null;
  const stubFor = (executionId: string): McpExecutionOwnerDirectoryStub =>
    toMcpExecutionOwnerDirectoryStub(namespace.get(namespace.idFromName(executionId)));
  return {
    put: (record) =>
      Effect.tryPromise({
        try: () => stubFor(record.executionId).put(record),
        catch: (cause) => new McpExecutionOwnerDirectoryRpcError({ cause }),
      }),
    get: (executionId) =>
      Effect.tryPromise({
        try: () => stubFor(executionId).get(executionId),
        catch: (cause) => new McpExecutionOwnerDirectoryRpcError({ cause }),
      }),
    delete: (executionId) =>
      Effect.tryPromise({
        try: () => stubFor(executionId).delete(executionId),
        catch: (cause) => new McpExecutionOwnerDirectoryRpcError({ cause }),
      }),
  };
};
