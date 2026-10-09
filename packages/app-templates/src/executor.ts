/** Source assets for the ordinary Executor app; hosts choose file I/O or bundled text. */
export {
  executorSkillFiles,
  readExecutorSkillDocuments,
  readExecutorSkills,
} from "./implementation/executor-skills.ts";
export { executorIntro } from "./implementation/executor-intro.gen.ts";
export { publishedSkillRoutes } from "./implementation/skill-publishing.ts";
export { annotateSkillRead } from "./implementation/skill-telemetry.ts";
