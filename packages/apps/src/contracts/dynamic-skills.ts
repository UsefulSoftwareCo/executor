/** Lazy skill loading, shaped like dynamic tools. Only skill reads call it. */
import type { Effect } from "effect";
import type { AppSkillSource } from "./skills.ts";

/**
 * `list` returns complete skills, including their files, added to the static catalog. Every
 * skill read loads the full catalog. Names must not repeat across both catalogs.
 */
export interface DynamicSkills {
  readonly list: () => Effect.Effect<readonly AppSkillSource[], unknown>;
}
