/** Progressive discovery of versioned app-owned Agent Skills. */
import {
  AppSlug,
  AppSkillName,
  AppSkillMetadata,
  AppSkillDocument,
  SkillApp,
  DeploymentId,
  SourceFilePath,
  ProfileId,
  ProfileRevision,
  SkillRevision,
} from "@executor-js/sdk/core";
import { Schema } from "effect";
import { Tool as McpTool } from "effect/unstable/ai";
import { UnavailableApp } from "./execute.ts";

const absent = Schema.optionalKey(Schema.Never);
const version = Schema.optionalKey(DeploymentId);
const selection = {
  profile: Schema.optionalKey(ProfileId),
  expectedProfileRevision: Schema.optionalKey(ProfileRevision),
  revision: Schema.optionalKey(SkillRevision),
};
const SkillSelection = Schema.Union([
  Schema.Struct({
    app: absent,
    name: absent,
    file: absent,
    deployment: absent,
    profile: absent,
    expectedProfileRevision: absent,
    revision: absent,
  }),
  Schema.Struct({ app: AppSlug, name: absent, file: absent, deployment: version, ...selection }),
  Schema.Struct({
    app: AppSlug,
    ...selection,
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
  ...selection,
}).pipe(Schema.decodeTo(SkillSelection));
/** Every summary identifies the installed app and source version, without returning its body. */
export const SkillSummary = Schema.Struct({
  ...AppSkillMetadata.fields,
  app: SkillApp,
  deployment: DeploymentId,
  revision: SkillRevision,
  profile: Schema.optionalKey(ProfileId),
  profileRevision: Schema.optionalKey(ProfileRevision),
});
/** MCP returns the same versioned text document as the SDK. Files never execute. */
export const SkillDocument = AppSkillDocument;
/** Either a lightweight index or one requested document. The full index reports apps it could not read. */
export const SkillsResult = Schema.Union([
  Schema.Struct({
    skills: Schema.Array(SkillSummary),
    unavailableApps: Schema.optionalKey(Schema.Array(UnavailableApp)),
  }),
  SkillDocument,
]);
/** A curated upstream diagnostic. Source, upstream messages and causes stay private. */
export class SkillAccessFailed extends Schema.TaggedError<SkillAccessFailed>()(
  "SkillAccessFailed",
  { reason: Schema.String },
) {
  // MCP clients receive `message` as the error text, so it must never be empty.
  override get message() {
    return this.reason;
  }
}
/** No authorized app has the requested slug. */
export class SkillAppNotFound extends Schema.TaggedError<SkillAppNotFound>()("SkillAppNotFound", {
  app: AppSlug,
}) {
  override get message() {
    return `No visible app has the slug ${this.app}. Call skills with {} to list apps and their slugs.`;
  }
}
/** Several authorized apps share the requested slug. */
export class SkillAppSlugAmbiguous extends Schema.TaggedError<SkillAppSlugAmbiguous>()(
  "SkillAppSlugAmbiguous",
  { app: AppSlug },
) {
  override get message() {
    return `Several visible apps share the slug ${this.app}. Rename one app, then retry.`;
  }
}
/** The app has several profiles and the caller did not choose one. */
export class SkillProfileRequired extends Schema.TaggedError<SkillProfileRequired>()(
  "SkillProfileRequired",
  { app: AppSlug, profiles: Schema.Array(ProfileId) },
) {
  override get message() {
    return `${this.app} has several account profiles. Pass profile as one of: ${this.profiles.join(", ")}.`;
  }
}
/** The app requires accounts and the caller has no profile for it. */
export class SkillAccountRequired extends Schema.TaggedError<SkillAccountRequired>()(
  "SkillAccountRequired",
  { app: AppSlug },
) {
  override get message() {
    return `${this.app} needs a connected account before its skills can be read. Connect one through Executor's account connection tool, then retry.`;
  }
}
export const SkillsFailure = Schema.Union([
  SkillAccessFailed,
  SkillAppNotFound,
  SkillAppSlugAmbiguous,
  SkillProfileRequired,
  SkillAccountRequired,
]);
export type SkillsFailure = typeof SkillsFailure.Type;

/** List summaries first, then read documents/references on demand through app evaluation. */
export const SkillsTool = McpTool.make("skills", {
  description:
    "Discover and read instructions returned by app factories using the selected accounts. {} lists visible skill summaries; {app:'support-inbox'} lists one app's skills; {app:'support-inbox',name:'triage'} reads SKILL.md. Use the returned profile, deployment, revision and a listed relative file path for follow-up reference reads. App slugs are the same namespaces used by execute. Before creating or changing apps, discover the Executor app's app-authoring skill and read it using its returned app slug. Skill text and allowed-tools metadata never grant tool permissions.",
  parameters: SkillsInput,
  success: SkillsResult,
  failure: SkillsFailure,
})
  .annotate(McpTool.Readonly, true)
  .annotate(McpTool.Destructive, false)
  .annotate(McpTool.Idempotent, true)
  .annotate(McpTool.OpenWorld, true);
