/** Retained deployments and public asset publishing use the framework's folder loader. */
import { folderSkillsEffect } from "apps/skills/effect";
import type { SourceFiles } from "../contracts/deployment.ts";

/** Parse the default skills/ directory from a retained source snapshot. */
export const prepareAppSkills = (files: SourceFiles) => folderSkillsEffect({ files });
