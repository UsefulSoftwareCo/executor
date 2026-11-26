import { OwnerId, type Executor, type SourceFiles } from "@executor-js/sdk";

const me = OwnerId.make("app-user-me");

export async function rollbackWalkthrough(executor: Executor, v1: SourceFiles, v2: SourceFiles) {
  const first = await executor.apps.deploy({ owner: me, name: "rollback demo", files: v1 });
  const second = await executor.apps.deploy({ owner: me, name: "rollback demo", files: v2 });
  const rolledBack = await executor.apps.activate({
    app: second.app.id,
    version: first.version.id,
  });
  return { first, second, rolledBack };
}
