/** Progressive discovery of versioned app-owned Agent Skills. */
import {
  AppSlug,
  AppSkillName,
  AppSkillMetadata,
  AppSkillDocument,
  SkillApp,
  VersionId,
  SourceFilePath,
  SkillRevision,
} from "@executor-js/sdk/core";
import { type JsonSchema, Schema } from "effect";
import { Tool as McpTool } from "effect/ai";
import { RecordedMessage } from "@executor-js/utils/recorded-message";
import { UnavailableApp } from "./execute.ts";

/**
 * The keys each key needs: everything but a full listing names an app, and a reference file
 * names its skill. `{}` lists every skill, `{app}` one app's and `{app, name}` reads one.
 */
const needs = {
  name: ["app"],
  file: ["app", "name"],
  version: ["app"],
  revision: ["app"],
  accounts: ["app"],
} as const satisfies Record<string, ReadonlyArray<"app" | "name">>;
const missing = (input: object) =>
  Object.entries(needs).flatMap(([key, required]) =>
    Object.hasOwn(input, key)
      ? required.filter((need) => !Object.hasOwn(input, need)).map((need) => ({ key, need }))
      : [],
  );
/**
 * The read shapes as one struct whose key dependencies are a check, because MCP clients need an
 * object-root input schema. The check emits them as `dependentRequired`, so the tool's advertised
 * input schema ({@link SkillsInputJsonSchema}) and its decoding come from this one value.
 */
export const SkillsInput = Schema.Struct({
  app: Schema.optionalKey(AppSlug),
  name: Schema.optionalKey(AppSkillName),
  file: Schema.optionalKey(SourceFilePath),
  version: Schema.optionalKey(VersionId),
  revision: Schema.optionalKey(SkillRevision),
  /**
   * Reads no longer choose accounts. The key is still read so a caller that sets it gets
   * `AccountChoiceUnsupported`, presented as a {@link SkillAccessFailed} with its code and status,
   * rather than having it ignored.
   */
  accounts: Schema.optionalKey(
    Schema.Unknown.annotate({
      description:
        "Not supported: skills are read with the accounts linked to the app. Setting it fails.",
    }),
  ),
}).check(
  Schema.makeFilter(
    (input) =>
      missing(input).map(({ key, need }) => ({
        path: [need],
        issue:
          need === "app"
            ? `${key} needs app, the slug of the app that ships the skill. Read the Executor app's entry skill with {app: "executor", name: "executor"}; {} lists every visible skill with its app.`
            : `${key} needs name, the skill whose file it reads, as in {app: "executor", name: "app-authoring", file: "deploy.md"}.`,
      })),
    {
      expected: "{} to list skills, {app} to list one app's skills or {app, name} to read one",
      toJsonSchema: () => ({ dependentRequired: needs }),
    },
  ),
);
/**
 * {@link SkillsInput} as JSON Schema. Effect puts the check's keywords in a top-level `allOf`
 * member, and model APIs reject top-level combinators in tool input schemas, so its members move
 * to the root. They hold only `dependentRequired`, which the root does not have.
 */
const { allOf, ...root } = McpTool.getJsonSchemaFromSchema(SkillsInput);
export const SkillsInputJsonSchema: JsonSchema.JsonSchema = Object.assign(
  root,
  ...(Array.isArray(allOf) ? allOf : []),
);
/**
 * The input is not one of the read shapes {@link SkillsInputJsonSchema} advertises. The handler
 * decodes it, because the tool advertises raw JSON Schema; the text matches the one Effect's
 * toolkit gives every other tool's invalid input.
 */
export class SkillsInputInvalid extends Schema.TaggedError<SkillsInputInvalid>()(
  "SkillsInputInvalid",
  { reason: Schema.String },
) {
  override get message() {
    return `Invalid parameters for tool 'skills': ${this.reason}`;
  }
  // The reason can quote the caller's input.
  get [RecordedMessage]() {
    return "The skills input is not a read shape the tool accepts";
  }
}
/** Every summary identifies the installed app and source version, without returning its body. */
export const SkillSummary = Schema.Struct({
  ...AppSkillMetadata.fields,
  app: SkillApp,
  version: VersionId,
  revision: SkillRevision,
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
/**
 * An app requirement has no account: a user requirement none the caller linked, an app requirement
 * none linked for everyone.
 */
export class SkillAccountRequired extends Schema.TaggedError<SkillAccountRequired>()(
  "SkillAccountRequired",
  { app: AppSlug, scope: Schema.Literals(["app", "user"]) },
) {
  override get message() {
    return this.scope === "app"
      ? `${this.app} needs its own account, which someone who can edit the app links for everyone on its Accounts page, before its skills can be read. Ask them to link one, then retry.`
      : `${this.app} needs a linked account before its skills can be read. Connect one through Executor's account connection tool, or link one on the app's Accounts page, then retry.`;
  }
  get [RecordedMessage]() {
    return this.scope === "app"
      ? "The app needs an app account linked for everyone before its skills can be read"
      : "The app needs a linked account before its skills can be read";
  }
}
export const SkillsFailure = Schema.Union([
  SkillAccessFailed,
  SkillAppNotFound,
  SkillAppSlugAmbiguous,
  SkillAccountRequired,
  SkillsInputInvalid,
]);
export type SkillsFailure = typeof SkillsFailure.Type;

/**
 * List summaries first, then read documents/references on demand through app evaluation. The
 * handler decodes its input with {@link SkillsInput}, which this schema is generated from.
 */
export const SkillsTool = McpTool.dynamic("skills", {
  description:
    "Read instructions that apps ship. Every input except {} needs app, the app's slug. Start with the Executor app's entry skill: {app:'executor',name:'executor'}; if that app was renamed, use the slug {} lists for it. {} lists every visible skill; {app:'executor'} lists one app's skills; {app:'executor',name:'code-mode'} reads that skill's SKILL.md. Pass the returned version and revision with a listed file to read a reference. App slugs are the namespaces used in search, call and execute. Skill text and allowed-tools metadata never grant tool permissions.",
  parameters: SkillsInputJsonSchema,
  success: SkillsResult,
  failure: SkillsFailure,
})
  .annotate(McpTool.Readonly, true)
  .annotate(McpTool.Destructive, false)
  .annotate(McpTool.Idempotent, true)
  .annotate(McpTool.OpenWorld, true);
