/**
 * Host protocol 2: protocol 1, and a skill catalog reply that says whether its `dynamicSkills`
 * loader read through the app cache.
 *
 * Every other message is protocol 1's, re-exported unchanged. Once released this protocol is
 * frozen like protocol 1: `bun run check` compares `protocol2` with `packages/apps/protocols/2.json`.
 * The module imports only `effect` and earlier protocol modules, so no change elsewhere can alter
 * it. Define the next protocol to change it. See notes/apps-publishing.md.
 */
import { Schema } from "effect";
import { AppSkills, protocol1 } from "./1.ts";

export * from "./1.ts";

/**
 * A skill catalog and whether any of it came from `dynamicSkills`. Without a live loader the
 * catalog is determined by the build and its evaluation inputs; with one it reflects a publisher.
 * `cached` says the loader read through the app cache, so the cache's freshness and invalidation
 * govern its publisher reads.
 */
export const SkillSources = Schema.Struct({
  skills: AppSkills,
  dynamic: Schema.Boolean,
  cached: Schema.optionalKey(Schema.Boolean),
});
export type SkillSources = typeof SkillSources.Type;
/** Either response shape; `dynamic` is unknown for builds that predate skillSources. */
export const SkillCatalogResponse = Schema.Union([SkillSources, AppSkills]);

/** Every message of protocol 2, in the order its snapshot records them. */
export const protocol2 = {
  version: 2,
  schemas: { ...protocol1.schemas, skills: SkillCatalogResponse },
} as const;
