// Scoped adapter — wraps a DBAdapter so every read on a tenant-scoped
// table filters by `scope_id IN (scopes)` and every write validates that
// its `scope_id` payload is one of the allowed scopes. Tables the
// schema doesn't declare a `scope_id` field on pass through untouched —
// the wrapper doesn't invent columns that aren't there.
//
// Writes are explicit: the caller must include `scope_id` in every
// create/createMany payload for scoped tables, and every update/delete
// must include a single `scope_id` equality in `where`. The adapter does
// not pick a default. A missing `scope_id`, or a value outside the allowed
// `scopes` array, is a `StorageError`.
//
// The SDK's `createExecutor` wraps the root adapter (and every tx
// handle passed back into transaction callbacks) with this before
// handing it to the core table writers or to plugin storage via
// `typedAdapter(...)`. Plugins see a stable DBAdapter; they learn their
// scope from `ctx.scopes` and stamp it explicitly on every write.
//
// Contract: every multi-tenant table's schema must include
// `scope_id: { type: "string", required: true, index: true }`. Tables
// without it are shared across scopes by construction.

import { Effect, type Brand } from "effect";

import {
  StorageError,
  typedAdapter,
  type DBAdapter,
  type DBSchema,
  type DBTransactionAdapter,
  type StorageFailure,
  type TypedAdapter,
  type Where,
} from "@executor-js/storage-core";

const SCOPE_FIELD = "scope_id";

export interface ScopeContext {
  /**
   * Precedence-ordered list of scope ids the wrapper accepts on reads
   * and writes. Innermost first. Reads walk every scope in the list
   * (via `scope_id IN (...)`); writes must name one of them explicitly
   * via `scope_id` in the payload.
   */
  readonly scopes: readonly string[];
}

/**
 * Adapter that has already been wrapped by `scopeAdapter`. Executor/plugin
 * internals should accept this branded type after construction, so a raw
 * adapter cannot be threaded into scoped storage by accident.
 */
export type ScopedDBAdapter = DBAdapter & Brand.Brand<"ScopedDBAdapter">;

/**
 * Plugin-facing typed adapter derived from a `ScopedDBAdapter`. It has the
 * same runtime shape as `TypedAdapter`, but the brand keeps StorageDeps from
 * being satisfied by `typedAdapter(rawAdapter)`.
 */
export type ScopedTypedAdapter<TSchema extends DBSchema> = TypedAdapter<TSchema, StorageFailure> &
  Brand.Brand<"ScopedTypedAdapter">;

export const scopedTypedAdapter = <TSchema extends DBSchema>(
  adapter: ScopedDBAdapter,
): ScopedTypedAdapter<TSchema> => typedAdapter<TSchema>(adapter) as ScopedTypedAdapter<TSchema>;

const collectScopedModels = (schema: DBSchema): Set<string> => {
  const out = new Set<string>();
  for (const [model, def] of Object.entries(schema)) {
    if (def.fields[SCOPE_FIELD]) out.add(model);
  }
  return out;
};

const withScopeRead = (where: readonly Where[] | undefined, ctx: ScopeContext): Where[] => {
  const base = (where ?? []).filter((w) => w.field !== SCOPE_FIELD);
  const callerScope = (where ?? []).find((w) => w.field === SCOPE_FIELD);

  // Honor a caller-supplied scope filter IF it names a single scope
  // that lives in the executor's stack. This turns a stack-wide read
  // (default) into a single-scope read. An out-of-stack value is an
  // empty intersection with the current scope stack, so return an
  // always-false scope predicate instead of widening back to all
  // visible rows.
  if (
    callerScope &&
    typeof callerScope.value === "string" &&
    ctx.scopes.includes(callerScope.value)
  ) {
    return [...base, { field: SCOPE_FIELD, value: callerScope.value }];
  }
  if (callerScope) {
    return [...base, { field: SCOPE_FIELD, value: [], operator: "in" }];
  }

  const scope: Where =
    ctx.scopes.length === 1
      ? { field: SCOPE_FIELD, value: ctx.scopes[0]! }
      : { field: SCOPE_FIELD, value: [...ctx.scopes], operator: "in" };
  return [...base, scope];
};

const assertScopedWrite = (
  model: string,
  data: Record<string, unknown>,
  ctx: ScopeContext,
): Effect.Effect<void, StorageError> => {
  const value = data[SCOPE_FIELD];
  if (typeof value !== "string" || value.length === 0) {
    return Effect.fail(
      new StorageError({
        message:
          `Write to scoped table "${model}" missing required \`scope_id\`. ` +
          `Callers must name the target scope explicitly.`,
        cause: undefined,
      }),
    );
  }
  if (!ctx.scopes.includes(value)) {
    return Effect.fail(
      new StorageError({
        message:
          `Write to scoped table "${model}" targets scope "${value}" ` +
          `which is not in the executor's scope stack ` +
          `[${ctx.scopes.join(", ")}].`,
        cause: undefined,
      }),
    );
  }
  return Effect.void;
};

const assertScopedMutationWhere = (
  model: string,
  where: readonly Where[] | undefined,
  ctx: ScopeContext,
): Effect.Effect<void, StorageError> => {
  const callerScope = (where ?? []).find((w) => w.field === SCOPE_FIELD);
  if (!callerScope || typeof callerScope.value !== "string" || callerScope.value.length === 0) {
    return Effect.fail(
      new StorageError({
        message:
          `Mutation on scoped table "${model}" missing required \`scope_id\` in where. ` +
          `Callers must name the target scope explicitly.`,
        cause: undefined,
      }),
    );
  }
  if (!ctx.scopes.includes(callerScope.value)) {
    return Effect.fail(
      new StorageError({
        message:
          `Mutation on scoped table "${model}" targets scope "${callerScope.value}" ` +
          `which is not in the executor's scope stack ` +
          `[${ctx.scopes.join(", ")}].`,
        cause: undefined,
      }),
    );
  }
  return Effect.void;
};

type TxMethods = Omit<DBAdapter, "transaction" | "createSchema" | "options">;

const wrapTxMethods = (
  inner: TxMethods,
  ctx: ScopeContext,
  scopedModels: Set<string>,
): TxMethods => {
  const isScoped = (model: string) => scopedModels.has(model);

  return {
    id: inner.id,
    create: (data) =>
      isScoped(data.model)
        ? Effect.flatMap(
            assertScopedWrite(data.model, data.data as Record<string, unknown>, ctx),
            () => inner.create(data),
          )
        : inner.create(data),
    createMany: (data) =>
      isScoped(data.model)
        ? Effect.flatMap(
            Effect.all(
              data.data.map((row) =>
                assertScopedWrite(data.model, row as Record<string, unknown>, ctx),
              ),
            ),
            () => inner.createMany(data),
          )
        : inner.createMany(data),
    findOne: (data) =>
      isScoped(data.model)
        ? inner.findOne({ ...data, where: withScopeRead(data.where, ctx) })
        : inner.findOne(data),
    findMany: (data) =>
      isScoped(data.model)
        ? inner.findMany({ ...data, where: withScopeRead(data.where, ctx) })
        : inner.findMany(data),
    count: (data) =>
      isScoped(data.model)
        ? inner.count({ ...data, where: withScopeRead(data.where, ctx) })
        : inner.count(data),
    update: (data) =>
      isScoped(data.model)
        ? Effect.flatMap(
            Effect.all([
              assertScopedMutationWhere(data.model, data.where, ctx),
              (data.update as Record<string, unknown>)[SCOPE_FIELD] !== undefined
                ? assertScopedWrite(data.model, data.update as Record<string, unknown>, ctx)
                : Effect.void,
            ]),
            () =>
              inner.update({
                ...data,
                where: withScopeRead(data.where, ctx),
              }),
          )
        : inner.update(data),
    updateMany: (data) =>
      isScoped(data.model)
        ? Effect.flatMap(
            Effect.all([
              assertScopedMutationWhere(data.model, data.where, ctx),
              (data.update as Record<string, unknown>)[SCOPE_FIELD] !== undefined
                ? assertScopedWrite(data.model, data.update as Record<string, unknown>, ctx)
                : Effect.void,
            ]),
            () =>
              inner.updateMany({
                ...data,
                where: withScopeRead(data.where, ctx),
              }),
          )
        : inner.updateMany(data),
    delete: (data) =>
      isScoped(data.model)
        ? Effect.flatMap(assertScopedMutationWhere(data.model, data.where, ctx), () =>
            inner.delete({ ...data, where: withScopeRead(data.where, ctx) }),
          )
        : inner.delete(data),
    deleteMany: (data) =>
      isScoped(data.model)
        ? Effect.flatMap(assertScopedMutationWhere(data.model, data.where, ctx), () =>
            inner.deleteMany({ ...data, where: withScopeRead(data.where, ctx) }),
          )
        : inner.deleteMany(data),
  };
};

export const scopeTransactionAdapter = (
  inner: DBTransactionAdapter,
  ctx: ScopeContext,
  schema: DBSchema,
): DBTransactionAdapter => wrapTxMethods(inner, ctx, collectScopedModels(schema));

export const scopeAdapter = (
  inner: DBAdapter,
  ctx: ScopeContext,
  schema: DBSchema,
): ScopedDBAdapter => {
  const scopedModels = collectScopedModels(schema);
  const tx = wrapTxMethods(inner, ctx, scopedModels);
  return {
    ...tx,
    transaction: (callback) =>
      inner.transaction((rawTrx) => {
        const scopedTrx: DBTransactionAdapter = wrapTxMethods(rawTrx, ctx, scopedModels);
        return callback(scopedTrx);
      }),
    createSchema: inner.createSchema,
    options: inner.options,
  } as ScopedDBAdapter;
};

export const __scopeField = SCOPE_FIELD;
