/** Read-only app browsing shares views, while each product owns transport and authorization. */
import type {
  AppSkillCatalog,
  AppSkillBundle,
  HostedWorkflow,
  WorkflowRunPage,
  WorkflowRunId,
} from "@executor-js/sdk";
import type { Query } from "./dashboard.ts";

/** Follow-up skill reads always use the catalog's retained deployment. */
export interface SkillBindings<E> {
  readonly skills: Query<AppSkillCatalog, E>;
  readonly bundle: Query<AppSkillBundle, E>;
}
/** Run pages refresh independently of account-dependent definition discovery. */
export interface WorkflowBindings<E> {
  readonly workflows: Query<readonly HostedWorkflow[], E>;
  readonly runs: (
    workflow: string | undefined,
    cursor: WorkflowRunId | undefined,
  ) => Query<WorkflowRunPage, E>;
}
