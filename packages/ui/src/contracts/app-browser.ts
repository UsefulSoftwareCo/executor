import type {
  AppSkillCatalog,
  AppSkillBundle,
  HostedWorkflow,
  Version,
  WorkflowRunPage,
  WorkflowRunId,
} from "@executor-js/sdk";
import type { Query } from "./dashboard.ts";

export interface SkillBindings<E> {
  readonly skills: Query<AppSkillCatalog, E>;
  readonly bundle: Query<AppSkillBundle, E>;
}
export interface WorkflowBindings<E> {
  readonly workflows: Query<readonly HostedWorkflow[], E>;
  readonly runs: (
    workflow: string | undefined,
    cursor: WorkflowRunId | undefined,
  ) => Query<WorkflowRunPage, E>;

  readonly source?: Query<Version, E> | undefined;
}
