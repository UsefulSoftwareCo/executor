/** Author-facing lazy skill sources adapt once to the framework's Effect execution path. */
import type { DynamicSkills } from "../contracts/dynamic-skills.ts";
import type { AppSkillSource } from "../contracts/skills.ts";
import { fromPromise } from "./authoring.ts";

/** Declare skills that load only when skills are read, such as `list: () => githubSkills({...})`. */
export const dynamicSkills = (source: {
  readonly list: () => readonly AppSkillSource[] | Promise<readonly AppSkillSource[]>;
}): DynamicSkills => ({
  list: fromPromise(async () => source.list()),
});
