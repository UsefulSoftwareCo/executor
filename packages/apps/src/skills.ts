/** Load standard Agent Skills into the same portable catalog an app can author directly. */
import { Effect, Schema } from "effect";
import {
  githubSkillsEffect,
  reader,
  wellKnownSkillsEffect,
  withService,
} from "./implementation/skills.ts";
import { skillFromFiles, folderSkillsEffect } from "./implementation/skill-files.ts";
import {
  SkillServiceName,
  type FolderSkillsOptions,
  type GitHubSkillsOptions,
  type SkillReaderOptions,
  type WellKnownSkillsOptions,
  type SkillFile,
} from "./contracts/skills.ts";
export {
  SkillLoadFailed,
  SkillDefinitionInvalid,
  SkillServiceName,
  type SkillReaderOptions,
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

/**
 * Read files for a custom remote skill loader, such as one for GitLab. Reads share one byte
 * budget and reject with the same safe SkillLoadFailed errors as githubSkills, naming `service`.
 */
export const skillReader = (options: SkillReaderOptions) => {
  const service = Schema.decodeUnknownSync(SkillServiceName)(options.service);
  const remote = Effect.runSync(reader(options));
  const run = <A>(effect: Effect.Effect<A, import("./contracts/skills.ts").SkillLoadFailed>) =>
    Effect.runPromise(
      effect.pipe(withService(service)),
      options.signal === undefined ? {} : { signal: options.signal },
    );
  return {
    /** Fetch one UTF-8 text file. */
    text: (url: string) => run(remote.read(url)),
    /** Fetch and parse one JSON document. */
    json: (url: string) => run(remote.json(url)),
  };
};
