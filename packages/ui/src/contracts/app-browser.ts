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
  /** The active version's source, for people who may read it; workflows are drawn from it. */
  readonly source?: Query<Version, E> | undefined;
}
