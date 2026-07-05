import { join } from "node:path";

import { Effect } from "effect";

import { makeGitArtifactStore } from "../backing/git-artifact-store";
import { makeLibsqlScopeDb } from "../backing/libsql-scope-db";
import { makeQuickjsToolSandbox } from "../backing/quickjs-tool-sandbox";
import { makeSqliteWorkflowRunner } from "../backing/sqlite-workflow-runner";
import { makeInProcessLiveChannel } from "../backing/in-process-live-channel";
import type { ScopeDb } from "../seams/scope-db";
import type { LiveChannel } from "../seams/live-channel";
import { makeAppsRuntime, type AppsRuntime } from "./runtime";
import type { AppsStore } from "./store";
import type { ClientResolver } from "./bindings";

// ---------------------------------------------------------------------------
// Wire the five self-hosted seam backings into one AppsRuntime, rooted at a
// data directory. This is what the self-host app calls at boot. The ScopeDb's
// write events are wired into the LiveChannel here (invalidation delivery), and
// the store is provided by the caller (over the host's pluginStorage + blobs).
// ---------------------------------------------------------------------------

export interface SelfHostAppsRuntimeOptions {
  /** Data dir root; `<root>/artifacts`, `<root>/scope-db`, `<root>/workflows`. */
  readonly dataDir: string;
  /** Store over the host's pluginStorage + blobs. */
  readonly store: AppsStore;
  /** Routes bound integration calls to real APIs (policy/audit). */
  readonly resolver: ClientResolver;
  /** In-memory backings for tests. */
  readonly inMemory?: boolean;
}

export interface SelfHostAppsRuntime {
  readonly runtime: AppsRuntime;
  readonly scopeDb: ScopeDb;
  readonly liveChannel: LiveChannel;
  readonly close: () => Promise<void>;
}

export const makeSelfHostAppsRuntime = (
  options: SelfHostAppsRuntimeOptions,
): SelfHostAppsRuntime => {
  const inMem = options.inMemory === true;
  const artifactStore = makeGitArtifactStore({
    root: inMem ? options.dataDir : join(options.dataDir, "artifacts"),
  });
  const scopeDb = makeLibsqlScopeDb({
    root: inMem ? ":memory:" : join(options.dataDir, "scope-db"),
  });
  const sandbox = makeQuickjsToolSandbox();
  const workflows = makeSqliteWorkflowRunner({
    path: inMem ? ":memory:" : join(options.dataDir, "workflows", "journal.db"),
  });
  const liveChannel = makeInProcessLiveChannel();

  // Wire scope-db writes -> live invalidations.
  const unwire = scopeDb.onWrite((event) => {
    for (const t of event.tables) {
      void Effect.runPromise(
        liveChannel.publish({ scope: event.scope, table: t.table, version: t.version }),
      );
    }
  });

  const runtime = makeAppsRuntime({
    artifactStore,
    scopeDb,
    sandbox,
    workflows,
    liveChannel,
    store: options.store,
    resolver: options.resolver,
  });

  return {
    runtime,
    scopeDb,
    liveChannel,
    close: async () => {
      unwire();
      await Effect.runPromise(scopeDb.close().pipe(Effect.orElseSucceed(() => undefined)));
      await Effect.runPromise(workflows.close().pipe(Effect.orElseSucceed(() => undefined)));
    },
  };
};
