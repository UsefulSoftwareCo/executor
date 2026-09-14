import {
  Context,
  definePlugin,
  definePluginStorageCollection,
  Effect,
  HttpApiBuilder,
  isValidPattern,
  matchPattern,
  Schema,
  type Owner,
  type PluginCtx,
  type PluginStorageFacade,
  type PluginStorageCollectionFacade,
  type StorageFailure,
  type ToolPolicyAction,
  type ToolProjection,
  type ToolProjectionSource,
} from "@executor-js/sdk/core";
import { addGroup, capture } from "@executor-js/api";
import { generateKeyBetween } from "fractional-indexing";

import { ToolkitError, ToolkitsApi } from "./shared";

const ToolkitRecord = Schema.Struct({
  id: Schema.String,
  slug: Schema.String,
  name: Schema.String,
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
});
type ToolkitRecord = typeof ToolkitRecord.Type;

const ToolkitPolicyRecord = Schema.Struct({
  id: Schema.String,
  toolkitId: Schema.String,
  pattern: Schema.String,
  action: Schema.Literals(["approve", "require_approval", "block"]),
  position: Schema.String,
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
});
type ToolkitPolicyRecord = typeof ToolkitPolicyRecord.Type;

const ToolkitConnectionRecord = Schema.Struct({
  id: Schema.String,
  toolkitId: Schema.String,
  pattern: Schema.String,
  position: Schema.String,
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
});
type ToolkitConnectionRecord = typeof ToolkitConnectionRecord.Type;

const toolkitsCollection = definePluginStorageCollection("toolkits", ToolkitRecord, {
  indexes: ["slug", "name", "updatedAt"],
});

const toolkitPoliciesCollection = definePluginStorageCollection(
  "toolkitPolicies",
  ToolkitPolicyRecord,
  {
    indexes: ["toolkitId", "pattern", "position", ["toolkitId", "position"]],
  },
);

const toolkitConnectionsCollection = definePluginStorageCollection(
  "toolkitConnections",
  ToolkitConnectionRecord,
  {
    indexes: ["toolkitId", "pattern", "position", ["toolkitId", "position"]],
  },
);

type ToolkitStorage = {
  readonly toolkits: PluginStorageCollectionFacade<typeof toolkitsCollection>;
  readonly policies: PluginStorageCollectionFacade<typeof toolkitPoliciesCollection>;
  readonly connections: PluginStorageCollectionFacade<typeof toolkitConnectionsCollection>;
};

const newId = (prefix: string): string =>
  `${prefix}_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;

const slugPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

const slugify = (name: string): string =>
  name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);

const normalizeSlugEffect = (input: {
  readonly name: string;
  readonly slug?: string;
}): Effect.Effect<string, ToolkitError> => {
  const slug = (input.slug ?? slugify(input.name)).trim().toLowerCase();
  if (!slugPattern.test(slug)) {
    return Effect.fail(
      new ToolkitError({
        message:
          "Toolkit slug must be 1-63 lowercase letters, numbers, or hyphens, and cannot start or end with a hyphen.",
      }),
    );
  }
  return Effect.succeed(slug);
};

const fail = (message: string): Effect.Effect<never, ToolkitError> =>
  Effect.fail(new ToolkitError({ message }));

const validatePolicyPattern = (pattern: string): Effect.Effect<void, ToolkitError> =>
  isValidPattern(pattern)
    ? Effect.void
    : Effect.fail(
        new ToolkitError({
          message: `Invalid toolkit policy pattern: ${pattern}`,
        }),
      );

const comparePositioned = (
  a: Pick<ToolkitPolicyRecord, "id" | "position">,
  b: Pick<ToolkitPolicyRecord, "id" | "position">,
): number => {
  if (a.position < b.position) return -1;
  if (a.position > b.position) return 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};

const isLegacyConnectionPolicy = (policy: ToolkitPolicyRecord): boolean => {
  if (policy.action !== "approve") return false;
  const parts = policy.pattern.split(".");
  return parts.at(-1) === "*" && (parts.length === 3 || parts.length === 4);
};

// A toolkit as core consumes it: the connections (plus any legacy
// connection-shaped approve rows) name what is VISIBLE, the remaining policies
// are the overlay core layers on top of the workspace's own rules. An
// org-owned toolkit never exposes a member's personal connections, whoever
// holds its URL.
const toolkitProjection = (
  owner: Owner,
  connections: readonly ToolkitConnectionRecord[],
  policies: readonly ToolkitPolicyRecord[],
): ToolProjection => {
  const legacyPolicyIds = legacyConnectionPolicyIds(policies, connections);
  return {
    visible: [
      ...connections.map((connection) => connection.pattern),
      ...policies
        .filter((policy) => legacyPolicyIds.has(policy.id))
        .map((policy) => policy.pattern),
    ],
    rules: policies
      .filter((policy) => !legacyPolicyIds.has(policy.id))
      .map((policy) => ({
        id: policy.id,
        pattern: policy.pattern,
        action: policy.action,
        position: policy.position,
      })),
    excludePersonal: owner === "org",
  };
};

const legacyConnectionPolicyIds = (
  policies: readonly ToolkitPolicyRecord[],
  connections: readonly ToolkitConnectionRecord[],
): ReadonlySet<string> => {
  return new Set(
    policies
      .filter(
        (policy) =>
          isLegacyConnectionPolicy(policy) &&
          !connections.some((connection) => matchPattern(policy.pattern, connection.pattern)),
      )
      .map((policy) => policy.id),
  );
};

const toolkitToResponse = (entry: { readonly owner: Owner; readonly data: ToolkitRecord }) => ({
  id: entry.data.id,
  owner: entry.owner,
  slug: entry.data.slug,
  name: entry.data.name,
  createdAt: entry.data.createdAt,
  updatedAt: entry.data.updatedAt,
});

const policyToResponse = (policy: ToolkitPolicyRecord) => ({
  id: policy.id,
  toolkitId: policy.toolkitId,
  pattern: policy.pattern,
  action: policy.action,
  position: policy.position,
  createdAt: policy.createdAt,
  updatedAt: policy.updatedAt,
});

const connectionToResponse = (connection: ToolkitConnectionRecord) => ({
  id: connection.id,
  toolkitId: connection.toolkitId,
  pattern: connection.pattern,
  position: connection.position,
  createdAt: connection.createdAt,
  updatedAt: connection.updatedAt,
});

const makeToolkitStorage = (pluginStorage: PluginStorageFacade): ToolkitStorage => ({
  toolkits: pluginStorage.collection(toolkitsCollection),
  policies: pluginStorage.collection(toolkitPoliciesCollection),
  connections: pluginStorage.collection(toolkitConnectionsCollection),
});

const makeToolkitsExtension = (ctx: PluginCtx<ToolkitStorage>) => {
  const storage = ctx.storage;

  const list = () =>
    storage.toolkits
      .query({ orderBy: [{ field: "name" }] })
      .pipe(
        Effect.map((entries) =>
          entries
            .map(toolkitToResponse)
            .sort(
              (a, b) =>
                (a.owner === b.owner ? 0 : a.owner === "org" ? -1 : 1) ||
                a.name.localeCompare(b.name) ||
                a.slug.localeCompare(b.slug),
            ),
        ),
      );

  const getEntry = (toolkitId: string) => storage.toolkits.get({ key: toolkitId });

  const getBySlugEntry = (slug: string) =>
    storage.toolkits
      .query({ where: { slug } })
      .pipe(
        Effect.map(
          (entries) => entries.find((entry) => entry.owner === "org") ?? entries[0] ?? null,
        ),
      );

  const requireToolkit = (toolkitId: string) =>
    getEntry(toolkitId).pipe(
      Effect.flatMap((entry) => (entry ? Effect.succeed(entry) : fail("Toolkit not found."))),
    );

  const assertSlugAvailable = (slug: string, ignoreToolkitId?: string) =>
    storage.toolkits.query({ where: { slug } }).pipe(
      Effect.flatMap((entries) => {
        const collision = entries.find((entry) => entry.data.id !== ignoreToolkitId);
        return collision ? fail(`Toolkit slug "${slug}" is already in use.`) : Effect.void;
      }),
    );

  const listPoliciesForRecord = (toolkitId: string) =>
    storage.policies
      .query({ where: { toolkitId } })
      .pipe(Effect.map((entries) => entries.map((entry) => entry.data).sort(comparePositioned)));

  const listConnectionsForRecord = (toolkitId: string) =>
    storage.connections
      .query({ where: { toolkitId } })
      .pipe(Effect.map((entries) => entries.map((entry) => entry.data).sort(comparePositioned)));

  const requirePolicy = (toolkitId: string, policyId: string, owner: Owner) =>
    storage.policies
      .getForOwner({ owner, key: policyId })
      .pipe(
        Effect.flatMap((entry) =>
          entry && entry.data.toolkitId === toolkitId
            ? Effect.succeed(entry)
            : fail("Toolkit policy not found."),
        ),
      );

  const requireConnection = (toolkitId: string, connectionId: string, owner: Owner) =>
    storage.connections
      .getForOwner({ owner, key: connectionId })
      .pipe(
        Effect.flatMap((entry) =>
          entry && entry.data.toolkitId === toolkitId
            ? Effect.succeed(entry)
            : fail("Toolkit connection not found."),
        ),
      );

  const create = (input: {
    readonly owner: Owner;
    readonly name: string;
    readonly slug?: string;
  }) =>
    Effect.gen(function* () {
      const name = input.name.trim();
      if (!name) return yield* fail("Toolkit name is required.");
      const slug = yield* normalizeSlugEffect({ name, slug: input.slug });
      yield* assertSlugAvailable(slug);
      const now = Date.now();
      const id = newId("tk");
      const entry = yield* storage.toolkits.put({
        owner: input.owner,
        key: id,
        data: { id, slug, name, createdAt: now, updatedAt: now },
      });
      return toolkitToResponse(entry);
    });

  const update = (toolkitId: string, input: { readonly name?: string; readonly slug?: string }) =>
    Effect.gen(function* () {
      const existing = yield* requireToolkit(toolkitId);
      const name = input.name === undefined ? existing.data.name : input.name.trim();
      if (!name) return yield* fail("Toolkit name is required.");
      const slug =
        input.slug === undefined
          ? existing.data.slug
          : yield* normalizeSlugEffect({ name, slug: input.slug });
      yield* assertSlugAvailable(slug, toolkitId);
      const entry = yield* storage.toolkits.put({
        owner: existing.owner,
        key: toolkitId,
        data: { ...existing.data, name, slug, updatedAt: Date.now() },
      });
      return toolkitToResponse(entry);
    });

  const remove = (toolkitId: string) =>
    Effect.gen(function* () {
      const toolkit = yield* requireToolkit(toolkitId);
      const policies = yield* listPoliciesForRecord(toolkitId);
      const connections = yield* listConnectionsForRecord(toolkitId);
      yield* ctx.pluginStorage.removeMany({
        owner: toolkit.owner,
        entries: [
          { collection: toolkitsCollection.name, key: toolkitId },
          ...policies.map((policy) => ({
            collection: toolkitPoliciesCollection.name,
            key: policy.id,
          })),
          ...connections.map((connection) => ({
            collection: toolkitConnectionsCollection.name,
            key: connection.id,
          })),
        ],
      });
    });

  const listPolicies = (toolkitId: string) =>
    requireToolkit(toolkitId).pipe(Effect.flatMap(() => listPoliciesForRecord(toolkitId)));

  const createPolicy = (
    toolkitId: string,
    input: {
      readonly pattern: string;
      readonly action: ToolPolicyAction;
      readonly position?: string;
    },
  ) =>
    Effect.gen(function* () {
      yield* validatePolicyPattern(input.pattern);
      const toolkit = yield* requireToolkit(toolkitId);
      const existing = yield* listPoliciesForRecord(toolkitId);
      const minPosition = existing
        .map((row) => row.position)
        .sort()
        .at(0);
      const now = Date.now();
      const id = newId("tkpol");
      const entry = yield* storage.policies.put({
        owner: toolkit.owner,
        key: id,
        data: {
          id,
          toolkitId,
          pattern: input.pattern,
          action: input.action,
          position: input.position ?? generateKeyBetween(null, minPosition ?? null),
          createdAt: now,
          updatedAt: now,
        },
      });
      return policyToResponse(entry.data);
    });

  const updatePolicy = (
    toolkitId: string,
    policyId: string,
    input: {
      readonly pattern?: string;
      readonly action?: ToolPolicyAction;
      readonly position?: string;
    },
  ) =>
    Effect.gen(function* () {
      if (input.pattern !== undefined) yield* validatePolicyPattern(input.pattern);
      const toolkit = yield* requireToolkit(toolkitId);
      const existing = yield* requirePolicy(toolkitId, policyId, toolkit.owner);
      const entry = yield* storage.policies.put({
        owner: toolkit.owner,
        key: policyId,
        data: {
          ...existing.data,
          ...(input.pattern !== undefined ? { pattern: input.pattern } : {}),
          ...(input.action !== undefined ? { action: input.action } : {}),
          ...(input.position !== undefined ? { position: input.position } : {}),
          updatedAt: Date.now(),
        },
      });
      return policyToResponse(entry.data);
    });

  const removePolicy = (toolkitId: string, policyId: string) =>
    Effect.gen(function* () {
      const toolkit = yield* requireToolkit(toolkitId);
      yield* requirePolicy(toolkitId, policyId, toolkit.owner);
      yield* storage.policies.remove({ owner: toolkit.owner, key: policyId });
    });

  const listConnections = (toolkitId: string) =>
    requireToolkit(toolkitId).pipe(Effect.flatMap(() => listConnectionsForRecord(toolkitId)));

  const createConnection = (
    toolkitId: string,
    input: {
      readonly pattern: string;
      readonly position?: string;
    },
  ) =>
    Effect.gen(function* () {
      yield* validatePolicyPattern(input.pattern);
      const toolkit = yield* requireToolkit(toolkitId);
      const existing = yield* listConnectionsForRecord(toolkitId);
      const duplicate = existing.find((connection) => connection.pattern === input.pattern);
      if (duplicate) return connectionToResponse(duplicate);
      const minPosition = existing
        .map((row) => row.position)
        .sort()
        .at(0);
      const now = Date.now();
      const id = newId("tkconn");
      const entry = yield* storage.connections.put({
        owner: toolkit.owner,
        key: id,
        data: {
          id,
          toolkitId,
          pattern: input.pattern,
          position: input.position ?? generateKeyBetween(null, minPosition ?? null),
          createdAt: now,
          updatedAt: now,
        },
      });
      return connectionToResponse(entry.data);
    });

  const removeConnection = (toolkitId: string, connectionId: string) =>
    Effect.gen(function* () {
      const toolkit = yield* requireToolkit(toolkitId);
      yield* requireConnection(toolkitId, connectionId, toolkit.owner);
      yield* storage.connections.remove({ owner: toolkit.owner, key: connectionId });
    });

  /**
   * The toolkit named by `slug` as a projection core can serve, or `null` when
   * no such toolkit is visible to this owner binding. Three reads — the
   * toolkit, its policies, its connections — once per operation; core resolves
   * every tool in that operation against the returned snapshot.
   */
  const projectionForSlug = (slug: string): Effect.Effect<ToolProjection | null, StorageFailure> =>
    Effect.gen(function* () {
      const toolkit = yield* getBySlugEntry(slug);
      if (!toolkit) return null;
      const policies = yield* listPoliciesForRecord(toolkit.data.id);
      const connections = yield* listConnectionsForRecord(toolkit.data.id);
      return toolkitProjection(toolkit.owner, connections, policies);
    });

  return {
    list,
    create,
    update,
    remove,
    listPolicies: (toolkitId: string) =>
      listPolicies(toolkitId).pipe(Effect.map((policies) => policies.map(policyToResponse))),
    createPolicy,
    updatePolicy,
    removePolicy,
    listConnections: (toolkitId: string) =>
      listConnections(toolkitId).pipe(
        Effect.map((connections) => connections.map(connectionToResponse)),
      ),
    createConnection,
    removeConnection,
    projectionForSlug,
  };
};

export type ToolkitsExtension = ReturnType<typeof makeToolkitsExtension>;

export class ToolkitsExtensionService extends Context.Service<
  ToolkitsExtensionService,
  ToolkitsExtension
>()("ToolkitsExtensionService") {}

const ExecutorApiWithToolkits = addGroup(ToolkitsApi);

const ToolkitsHandlers = HttpApiBuilder.group(ExecutorApiWithToolkits, "toolkits", (handlers) =>
  handlers
    .handle("list", () =>
      capture(
        Effect.gen(function* () {
          const ext = yield* ToolkitsExtensionService;
          const toolkits = yield* ext.list();
          return { toolkits };
        }),
      ),
    )
    .handle("create", ({ payload }) =>
      capture(
        Effect.gen(function* () {
          const ext = yield* ToolkitsExtensionService;
          return yield* ext.create(payload);
        }),
      ),
    )
    .handle("update", ({ params, payload }) =>
      capture(
        Effect.gen(function* () {
          const ext = yield* ToolkitsExtensionService;
          return yield* ext.update(params.toolkitId, payload);
        }),
      ),
    )
    .handle("remove", ({ params }) =>
      capture(
        Effect.gen(function* () {
          const ext = yield* ToolkitsExtensionService;
          yield* ext.remove(params.toolkitId);
          return { removed: true };
        }),
      ),
    )
    .handle("listPolicies", ({ params }) =>
      capture(
        Effect.gen(function* () {
          const ext = yield* ToolkitsExtensionService;
          const policies = yield* ext.listPolicies(params.toolkitId);
          return { policies };
        }),
      ),
    )
    .handle("createPolicy", ({ params, payload }) =>
      capture(
        Effect.gen(function* () {
          const ext = yield* ToolkitsExtensionService;
          return yield* ext.createPolicy(params.toolkitId, payload);
        }),
      ),
    )
    .handle("updatePolicy", ({ params, payload }) =>
      capture(
        Effect.gen(function* () {
          const ext = yield* ToolkitsExtensionService;
          return yield* ext.updatePolicy(params.toolkitId, params.policyId, payload);
        }),
      ),
    )
    .handle("removePolicy", ({ params }) =>
      capture(
        Effect.gen(function* () {
          const ext = yield* ToolkitsExtensionService;
          yield* ext.removePolicy(params.toolkitId, params.policyId);
          return { removed: true };
        }),
      ),
    )
    .handle("listConnections", ({ params }) =>
      capture(
        Effect.gen(function* () {
          const ext = yield* ToolkitsExtensionService;
          const connections = yield* ext.listConnections(params.toolkitId);
          return { connections };
        }),
      ),
    )
    .handle("createConnection", ({ params, payload }) =>
      capture(
        Effect.gen(function* () {
          const ext = yield* ToolkitsExtensionService;
          return yield* ext.createConnection(params.toolkitId, payload);
        }),
      ),
    )
    .handle("removeConnection", ({ params }) =>
      capture(
        Effect.gen(function* () {
          const ext = yield* ToolkitsExtensionService;
          yield* ext.removeConnection(params.toolkitId, params.connectionId);
          return { removed: true };
        }),
      ),
    ),
);

const makeProjectionSource = (
  extension: Pick<ToolkitsExtension, "projectionForSlug">,
): ToolProjectionSource => ({
  resolve: (name) => extension.projectionForSlug(name),
});

export const toolkitsPlugin = definePlugin(() => ({
  id: "toolkits" as const,
  packageName: "@executor-js/plugin-toolkits",
  pluginStorage: {
    toolkits: toolkitsCollection,
    toolkitPolicies: toolkitPoliciesCollection,
    toolkitConnections: toolkitConnectionsCollection,
  },
  storage: ({ pluginStorage }) => makeToolkitStorage(pluginStorage),
  extension: makeToolkitsExtension,
  routes: () => ToolkitsApi,
  handlers: () => ToolkitsHandlers,
  extensionService: ToolkitsExtensionService,
  // Every executor built with this plugin can serve any toolkit by slug
  // (`executor.project(slug)`); the projection is a read over this plugin's
  // storage, not a different executor.
  toolProjections: (ctx: PluginCtx<ToolkitStorage>) =>
    makeProjectionSource(makeToolkitsExtension(ctx)),
}));

export default toolkitsPlugin;
