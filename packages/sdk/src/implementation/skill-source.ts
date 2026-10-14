/** Retained deployments and public asset publishing use the framework's folder loader. */
import { folderSkillsEffect } from "apps/skills/effect";
import { isTextFile, type SourceFile } from "../contracts/source.ts";

/** Parse the default skills/ directory from a retained source snapshot. */
export const prepareAppSkills = (files: ReadonlyArray<SourceFile>) =>
  folderSkillsEffect({ files: files.filter(isTextFile) });
