import type { ArtifactStore } from "../seams/artifact-store";
import type { ScopeDb } from "../seams/scope-db";
import type { ToolSandbox } from "../seams/tool-sandbox";
import { makeAppsRuntime, type AppsRuntime } from "./runtime";
import type { AppsStore } from "./store";
import type { ClientResolver } from "./bindings";

export interface AppsBackings {
  readonly artifactStore: ArtifactStore;
  readonly scopeDb: ScopeDb;
  readonly sandbox: ToolSandbox;
  readonly store: AppsStore;
  readonly defaultTenant?: string;
  readonly resolver?: ClientResolver;
}

export const makeAppsRuntimeFromBackings = (
  backings: AppsBackings,
  fallbackResolver: ClientResolver,
): AppsRuntime =>
  makeAppsRuntime({
    artifactStore: backings.artifactStore,
    scopeDb: backings.scopeDb,
    sandbox: backings.sandbox,
    store: backings.store,
    resolver: backings.resolver ?? fallbackResolver,
    defaultTenant: backings.defaultTenant,
  });
