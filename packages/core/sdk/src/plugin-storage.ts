import { Effect } from "effect";

import type { StorageFailure } from "./fuma-runtime";
import type { Owner } from "./ids";

export type PluginStorageSchema = {
  readonly Type: object;
};

export type PluginStorageSchemaType<TSchema extends PluginStorageSchema> = TSchema["Type"];

export type PluginStorageIndexField<TData extends object> = Extract<keyof TData, string>;

export type PluginStorageIndexSpec<TData extends object> =
  | PluginStorageIndexField<TData>
  | readonly PluginStorageIndexField<TData>[];

export type PluginStorageRuntimeIndexSpec = string | readonly string[];

export interface PluginStorageRuntimeCollectionDefinition {
  readonly name: string;
  readonly schema: PluginStorageSchema;
  readonly indexes: readonly PluginStorageRuntimeIndexSpec[];
}

export interface PluginStorageCollectionDefinition<
  TName extends string = string,
  TData extends object = Record<string, unknown>,
  TIndexes extends readonly PluginStorageIndexSpec<TData>[] =
    readonly PluginStorageIndexSpec<TData>[],
> extends PluginStorageRuntimeCollectionDefinition {
  readonly name: TName;
  readonly schema: PluginStorageSchema;
  readonly indexes: TIndexes;
}

export type PluginStorageConfig = Readonly<
  Record<string, PluginStorageRuntimeCollectionDefinition>
>;

export const definePluginStorageCollection = <
  const TName extends string,
  const TSchema extends PluginStorageSchema,
  const TIndexes extends readonly PluginStorageIndexSpec<PluginStorageSchemaType<TSchema>>[] =
    readonly [],
>(
  name: TName,
  schema: TSchema,
  options?: {
    readonly indexes?: TIndexes;
  },
): PluginStorageCollectionDefinition<TName, PluginStorageSchemaType<TSchema>, TIndexes> => ({
  name,
  schema,
  indexes: (options?.indexes ?? []) as TIndexes,
});

export type PluginStorageCollectionData<TDefinition> =
  TDefinition extends PluginStorageCollectionDefinition<infer _Name, infer TData, infer _Indexes>
    ? TData
    : never;

export type PluginStorageIndexFields<TIndexes> = TIndexes extends readonly (infer TIndex)[]
  ? TIndex extends readonly (infer TField)[]
    ? Extract<TField, string>
    : Extract<TIndex, string>
  : never;

export type PluginStorageCollectionIndexedField<TDefinition> =
  TDefinition extends PluginStorageCollectionDefinition<infer _Name, infer _Data, infer TIndexes>
    ? PluginStorageIndexFields<TIndexes>
    : never;

export interface PluginStorageWhereFilter<TValue> {
  readonly eq?: TValue;
  readonly in?: readonly TValue[];
  readonly gt?: TValue;
  readonly gte?: TValue;
  readonly lt?: TValue;
  readonly lte?: TValue;
}

export type PluginStorageWhereValue<TValue> = TValue | PluginStorageWhereFilter<TValue>;

export type PluginStorageCollectionWhere<TDefinition> = {
  readonly [TField in PluginStorageCollectionIndexedField<TDefinition>]?: PluginStorageWhereValue<
    TField extends keyof PluginStorageCollectionData<TDefinition>
      ? PluginStorageCollectionData<TDefinition>[TField]
      : never
  >;
};

export interface PluginStorageCollectionOrderBy<TDefinition> {
  readonly field: PluginStorageCollectionIndexedField<TDefinition>;
  readonly direction?: "asc" | "desc";
}

export interface PluginStorageKeyInput {
  readonly collection: string;
  readonly key: string;
}

export interface PluginStorageScopedKeyInput extends PluginStorageKeyInput {
  readonly owner: Owner;
}

export interface PluginStorageListInput {
  readonly collection: string;
  readonly keyPrefix?: string;
}

export interface PluginStoragePutInput extends PluginStorageScopedKeyInput {
  readonly data: unknown;
}

export interface PluginStoragePutManyEntry extends PluginStorageKeyInput {
  readonly data: unknown;
}

export interface PluginStoragePutManyInput {
  readonly owner: Owner;
  readonly entries: readonly PluginStoragePutManyEntry[];
}

export interface PluginStorageRemoveManyInput {
  readonly owner: Owner;
  readonly entries: readonly PluginStorageKeyInput[];
}

export interface PluginStorageCollectionKeyInput {
  readonly key: string;
}

export interface PluginStorageCollectionScopedKeyInput extends PluginStorageCollectionKeyInput {
  readonly owner: Owner;
}

export interface PluginStorageCollectionListInput {
  readonly keyPrefix?: string;
}

export interface PluginStorageCollectionPutInput<
  TData extends object,
> extends PluginStorageCollectionScopedKeyInput {
  readonly data: TData;
}

export interface PluginStorageCollectionQueryInput<TDefinition> {
  readonly keyPrefix?: string;
  readonly where?: PluginStorageCollectionWhere<TDefinition>;
  readonly orderBy?: readonly PluginStorageCollectionOrderBy<TDefinition>[];
  readonly limit?: number;
  readonly offset?: number;
}

export interface PluginStorageEntry<T = unknown> {
  readonly id: string;
  readonly owner: Owner;
  readonly pluginId: string;
  readonly collection: string;
  readonly key: string;
  readonly data: T;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export type PluginStorageScalar = string | number | boolean | null;

export type PluginStorageFieldType = "text" | "number" | "boolean";

export interface PluginStorageAggregateFilter<TDefinition> {
  readonly where?: PluginStorageCollectionWhere<TDefinition>;
  readonly keyPrefix?: string;
}

export interface PluginStorageGroupCountInput<
  TDefinition,
> extends PluginStorageAggregateFilter<TDefinition> {
  readonly field: PluginStorageCollectionIndexedField<TDefinition>;
  readonly valueType?: PluginStorageFieldType;
}

export interface PluginStorageTimeBucketInput<
  TDefinition,
> extends PluginStorageAggregateFilter<TDefinition> {
  /** Numeric (epoch-ms) field the buckets are computed from. */
  readonly field: PluginStorageCollectionIndexedField<TDefinition>;
  readonly bucketMs: number;
}

export interface PluginStorageStatsInput<
  TDefinition,
> extends PluginStorageAggregateFilter<TDefinition> {
  /** Numeric field the stats are computed over. */
  readonly field: PluginStorageCollectionIndexedField<TDefinition>;
  /** Percentile fractions in [0, 1] (e.g. 0.5, 0.95). */
  readonly percentiles?: readonly number[];
}

export interface PluginStorageGroupCount {
  readonly value: PluginStorageScalar;
  readonly count: number;
}

export interface PluginStorageTimeBucket {
  readonly bucket: number;
  readonly count: number;
}

export interface PluginStoragePercentile {
  readonly fraction: number;
  readonly value: number;
}

export interface PluginStorageStats {
  readonly count: number;
  readonly min: number | null;
  readonly max: number | null;
  readonly percentiles: readonly PluginStoragePercentile[];
}

export interface PluginStorageKeysetOrderBy<TDefinition> {
  readonly field: PluginStorageCollectionIndexedField<TDefinition>;
  readonly direction?: "asc" | "desc";
  readonly valueType?: PluginStorageFieldType;
}

export interface PluginStorageKeysetCursor {
  readonly values: readonly PluginStorageScalar[];
  readonly key: string;
}

export interface PluginStorageQueryKeysetInput<
  TDefinition,
> extends PluginStorageAggregateFilter<TDefinition> {
  readonly orderBy: readonly PluginStorageKeysetOrderBy<TDefinition>[];
  readonly limit: number;
  readonly cursor?: PluginStorageKeysetCursor;
}

export interface PluginStorageKeysetPage<TData extends object> {
  readonly entries: readonly PluginStorageEntry<TData>[];
  readonly nextCursor: PluginStorageKeysetCursor | null;
}

/** SQL-pushed aggregation over a collection's JSON documents. */
export interface PluginStorageAggregateFacade<
  TDefinition extends PluginStorageCollectionDefinition,
> {
  readonly count: (
    input?: PluginStorageAggregateFilter<TDefinition>,
  ) => Effect.Effect<number, StorageFailure>;
  readonly groupCount: (
    input: PluginStorageGroupCountInput<TDefinition>,
  ) => Effect.Effect<readonly PluginStorageGroupCount[], StorageFailure>;
  readonly timeBuckets: (
    input: PluginStorageTimeBucketInput<TDefinition>,
  ) => Effect.Effect<readonly PluginStorageTimeBucket[], StorageFailure>;
  readonly stats: (
    input: PluginStorageStatsInput<TDefinition>,
  ) => Effect.Effect<PluginStorageStats, StorageFailure>;
}

export interface PluginStorageCollectionFacade<
  TDefinition extends PluginStorageCollectionDefinition = PluginStorageCollectionDefinition,
> {
  readonly get: (
    input: PluginStorageCollectionKeyInput,
  ) => Effect.Effect<
    PluginStorageEntry<PluginStorageCollectionData<TDefinition>> | null,
    StorageFailure
  >;
  readonly getForOwner: (
    input: PluginStorageCollectionScopedKeyInput,
  ) => Effect.Effect<
    PluginStorageEntry<PluginStorageCollectionData<TDefinition>> | null,
    StorageFailure
  >;
  readonly list: (
    input?: PluginStorageCollectionListInput,
  ) => Effect.Effect<
    readonly PluginStorageEntry<PluginStorageCollectionData<TDefinition>>[],
    StorageFailure
  >;
  readonly put: (
    input: PluginStorageCollectionPutInput<PluginStorageCollectionData<TDefinition>>,
  ) => Effect.Effect<PluginStorageEntry<PluginStorageCollectionData<TDefinition>>, StorageFailure>;
  readonly query: (
    input?: PluginStorageCollectionQueryInput<TDefinition>,
  ) => Effect.Effect<
    readonly PluginStorageEntry<PluginStorageCollectionData<TDefinition>>[],
    StorageFailure
  >;
  readonly count: (
    input?: Omit<PluginStorageCollectionQueryInput<TDefinition>, "orderBy" | "limit" | "offset">,
  ) => Effect.Effect<number, StorageFailure>;
  /** SQL-pushed keyset pagination ordered by indexed JSON fields. */
  readonly queryKeyset: (
    input: PluginStorageQueryKeysetInput<TDefinition>,
  ) => Effect.Effect<
    PluginStorageKeysetPage<PluginStorageCollectionData<TDefinition>>,
    StorageFailure
  >;
  /** SQL-pushed aggregation (counts, facets, time buckets, percentiles). */
  readonly aggregate: PluginStorageAggregateFacade<TDefinition>;
  readonly remove: (
    input: PluginStorageCollectionScopedKeyInput,
  ) => Effect.Effect<void, StorageFailure>;
}

export interface PluginStorageFacade {
  readonly collection: <const TDefinition extends PluginStorageCollectionDefinition>(
    definition: TDefinition,
  ) => PluginStorageCollectionFacade<TDefinition>;
  readonly get: <T = unknown>(
    input: PluginStorageKeyInput,
  ) => Effect.Effect<PluginStorageEntry<T> | null, StorageFailure>;
  readonly getForOwner: <T = unknown>(
    input: PluginStorageScopedKeyInput,
  ) => Effect.Effect<PluginStorageEntry<T> | null, StorageFailure>;
  readonly list: <T = unknown>(
    input: PluginStorageListInput,
  ) => Effect.Effect<readonly PluginStorageEntry<T>[], StorageFailure>;
  readonly put: <T = unknown>(
    input: PluginStoragePutInput,
  ) => Effect.Effect<PluginStorageEntry<T>, StorageFailure>;
  readonly putMany: (input: PluginStoragePutManyInput) => Effect.Effect<void, StorageFailure>;
  readonly remove: (input: PluginStorageScopedKeyInput) => Effect.Effect<void, StorageFailure>;
  readonly removeMany: (input: PluginStorageRemoveManyInput) => Effect.Effect<void, StorageFailure>;
}

export const pluginStorageId = (input: {
  readonly pluginId: string;
  readonly collection: string;
  readonly key: string;
}): string => JSON.stringify([input.pluginId, input.collection, input.key]);
