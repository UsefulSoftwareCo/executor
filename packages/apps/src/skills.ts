/** Load standard Agent Skills into the same portable catalog an app can author directly. */
import { Effect } from "effect";
import { githubSkillsEffect, wellKnownSkillsEffect } from "./implementation/skills.ts";
import { skillFromFiles, folderSkillsEffect } from "./implementation/skill-files.ts";
import type {
  FolderSkillsOptions,
  GitHubSkillsOptions,
  WellKnownSkillsOptions,
  SkillFile,
} from "./contracts/skills.ts";
export {
  SkillLoadFailed,
  SkillDefinitionInvalid,
  type FolderSkillsOptions,
  type AppSkillSource as Skill,
  type SkillFile,
  type GitHubSkillsOptions,
  type WellKnownSkillsOptions,
} from "./contracts/skills.ts";

/** Fetch a public GitHub skill collection from one resolved commit. Mutable refs refresh on each call. */
export const githubSkills = (options: GitHubSkillsOptions) =>
  Effect.runPromise(
    githubSkillsEffect(options),
    options.signal === undefined ? {} : { signal: options.signal },
  );
/** Fetch a published skill index and its text files, with no persistent cache. */
export const wellKnownSkills = (options: WellKnownSkillsOptions) =>
  Effect.runPromise(
    wellKnownSkillsEffect(options),
    options.signal === undefined ? {} : { signal: options.signal },
  );
/** Parse a bundled standard skill directory into an app capability. */
export const fileSkill = (files: readonly SkillFile[]) => Effect.runPromise(skillFromFiles(files));

/** Read skill directories from ctx.files. Omitted path selects skills/; missing folders return []. */
export const folderSkills = (options: FolderSkillsOptions) =>
  Effect.runPromise(folderSkillsEffect(options));
