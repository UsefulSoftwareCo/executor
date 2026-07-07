import { join } from "node:path";

import { Effect } from "effect";

import {
  makeGitArtifactStore,
  makeLibsqlScopeDb,
  makeQuickjsToolSandbox,
  makeSqliteAppsStore,
  type AppsBackings,
} from "@executor-js/plugin-apps/api";

import { resolveDataDir } from "./config";

interface SelfHostAppsBackings {
  readonly backings: AppsBackings;
  readonly close: () => Promise<void>;
}

const createBackings = (dataDir: string): SelfHostAppsBackings => {
  const appsDir = join(dataDir, "apps");
  const scopeDb = makeLibsqlScopeDb({
    root: join(appsDir, "scope-db"),
  });
  return {
    backings: {
      artifactStore: makeGitArtifactStore({ root: join(appsDir, "artifacts") }),
      scopeDb,
      sandbox: makeQuickjsToolSandbox(),
      store: makeSqliteAppsStore({ path: join(appsDir, "store.sqlite") }),
    },
    close: async () => {
      await Effect.runPromise(scopeDb.close().pipe(Effect.orElseSucceed(() => undefined)));
    },
  };
};

let current: { readonly dataDir: string; readonly value: SelfHostAppsBackings } | undefined;

export const getSelfHostAppsBackings = (): AppsBackings => {
  const dataDir = resolveDataDir();
  if (current && current.dataDir === dataDir) return current.value.backings;
  const value = createBackings(dataDir);
  current = { dataDir, value };
  return value.backings;
};

export const closeSelfHostAppsBackings = async (): Promise<void> => {
  const value = current?.value;
  current = undefined;
  await value?.close();
};
