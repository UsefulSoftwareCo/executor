import type { Provider, RelationMode } from "./provider.ts";

export interface SqlAdapterConfig {
  readonly provider: Provider;
  readonly relationMode?: RelationMode | undefined;
}

export interface ResolvedSqlAdapterConfig {
  readonly provider: Provider;
  readonly relationMode: RelationMode;
}
