/** Existing code rollback seam. No state migration or automatic rollout policy is implemented. */
import { OwnerId, type Executor, type SourceFiles } from "@executor-js/sdk";

const me = OwnerId.make("app-user-me");

/** Deploy twice under one name, then reselect the first retained code deployment. */
export async function rollbackWalkthrough(executor: Executor, v1: SourceFiles, v2: SourceFiles) {
  const first = await executor.apps.deploy({ owner: me, name: "rollback demo", files: v1 });
  const second = await executor.apps.deploy({ owner: me, name: "rollback demo", files: v2 });
  const rolledBack = await executor.apps.activate({
    app: second.app.id,
    deployment: first.deployment.id,
  });
  return { first, second, rolledBack };
}
