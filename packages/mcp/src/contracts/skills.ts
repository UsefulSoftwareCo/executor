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
import { Tool as McpTool } from "effect/ai";
import { RecordedMessage } from "@executor-js/utils/recorded-message";
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
  // The reason can quote an app's own error, which only its caller receives.
  get [RecordedMessage]() {
    return "Executor could not read the app's skills";
  }
}
/** No authorized app has the requested slug. */
export class SkillAppNotFound extends Schema.TaggedError<SkillAppNotFound>()("SkillAppNotFound", {
  app: AppSlug,
}) {
  override get message() {
    return `No visible app has the slug ${this.app}. Call skills with {} to list apps and their slugs.`;
  }
  // The requested slug is the caller's text.
  get [RecordedMessage]() {
    return "No visible app has the requested slug";
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
  get [RecordedMessage]() {
    return "Several visible apps share the requested slug";
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
  get [RecordedMessage]() {
    return "The app has several account profiles and the call chose none";
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
  get [RecordedMessage]() {
    return "The app needs a connected account before its skills can be read";
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
    "Read instructions that apps ship. Start with the Executor app's executor skill: {app:'executor',name:'executor'}, using the slug {} returns if the app was renamed. {} lists visible skills; {app:'support-inbox'} lists one app's skills; {app:'support-inbox',name:'triage'} reads SKILL.md. Pass the returned profile, deployment and revision with a listed file to read a reference. App slugs are the namespaces used in execute. Skill text and allowed-tools metadata never grant tool permissions.",
  parameters: SkillsInput,
  success: SkillsResult,
  failure: SkillsFailure,
})
  .annotate(McpTool.Readonly, true)
  .annotate(McpTool.Destructive, false)
  .annotate(McpTool.Idempotent, true)
  .annotate(McpTool.OpenWorld, true);
