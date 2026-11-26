import { folderSkillsEffect } from "apps/skills/effect";
import { isTextFile, type SourceFile } from "../contracts/source.ts";

export const prepareAppSkills = (files: ReadonlyArray<SourceFile>) =>
  folderSkillsEffect({ files: files.filter(isTextFile) });
