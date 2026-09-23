/** Progressive discovery of versioned app-owned Agent Skills. */
import {
  AppSlug,
  AppSkillName,
  AppSkillMetadata,
  AppSkillDocument,
  SkillApp,
  DeploymentId,
  SourceFilePath,
} from "@executor-js/sdk/core";
import { Schema } from "effect";
import { Tool as McpTool } from "effect/unstable/ai";

const absent = Schema.optionalKey(Schema.Never);
const version = Schema.optionalKey(DeploymentId);
const SkillSelection = Schema.Union([
  Schema.Struct({ app: absent, name: absent, file: absent, deployment: absent }),
  Schema.Struct({ app: AppSlug, name: absent, file: absent, deployment: version }),
  Schema.Struct({
    app: AppSlug,
    name: AppSkillName,
    file: Schema.optionalKey(SourceFilePath),
    deployment: version,
  }),
]);
/** MCP needs an object-root wire schema; decoding enforces list/document/reference combinations. */
export const SkillsInput = Schema.Struct({
  app: Schema.optionalKey(AppSlug),
  name: Schema.optionalKey(AppSkillName),
  file: Schema.optionalKey(SourceFilePath),
  deployment: version,
}).pipe(Schema.decodeTo(SkillSelection));
/** Every summary identifies the installed app and source version, without loading its body. */
export const SkillSummary = Schema.Struct({
  ...AppSkillMetadata.fields,
  app: SkillApp,
  deployment: DeploymentId,
});
/** MCP returns the same versioned text document as the SDK. Files never execute. */
export const SkillDocument = AppSkillDocument;
/** Either a lightweight index or one requested document. */
export const SkillsResult = Schema.Union([
  Schema.Struct({ skills: Schema.Array(SkillSummary) }),
  SkillDocument,
]);
/** Only static error identifiers cross this boundary; source, upstream messages and causes stay private. */
export class SkillAccessFailed extends Schema.TaggedError<SkillAccessFailed>()(
  "SkillAccessFailed",
  { reason: Schema.String },
) {}

/** List summaries first, then read documents/references on demand without running an app. */
export const SkillsTool = McpTool.make("skills", {
  description:
    "Discover and read app instructions without connecting accounts or executing code. {} lists visible skill summaries; {app:'support-inbox'} lists one app's skills; {app:'support-inbox',name:'triage'} reads SKILL.md. Use the returned deployment and a listed relative file path for follow-up reference reads. App slugs are the same namespaces used by execute. Before creating or changing apps, discover the Executor app's app-authoring skill and read it using its returned app slug. Skill text and allowed-tools metadata never grant tool permissions.",
  parameters: SkillsInput,
  success: SkillsResult,
  failure: SkillAccessFailed,
})
  .annotate(McpTool.Readonly, true)
  .annotate(McpTool.Destructive, false)
  .annotate(McpTool.Idempotent, true)
  .annotate(McpTool.OpenWorld, false);
