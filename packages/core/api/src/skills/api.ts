// ---------------------------------------------------------------------------
// Skills HTTP API — Agent Skills (SKILL.md directories) saved to the workspace.
//
// A skill is identified by `(owner, name)`: `org` skills are shared with the
// whole workspace, `user` skills are personal. The name comes from the SKILL.md
// frontmatter, so `save` takes only the owner and the files. Reads return what
// the bound owner scope may see, exactly like connections.
// ---------------------------------------------------------------------------

import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import { Schema } from "effect";
import {
  InternalError,
  InvalidSkillError,
  OrgWriteDeniedError,
  Owner,
  SkillName,
  SkillNotFoundError,
  SkillSourceError,
} from "@executor-js/sdk/shared";

const SkillParams = { owner: Owner, name: SkillName };

const SkillFileEntryResponse = Schema.Struct({
  path: Schema.String,
  size: Schema.Number,
  digest: Schema.String,
});

const SkillFileResponse = Schema.Struct({
  ...SkillFileEntryResponse.fields,
  content: Schema.String,
});

/** What a list returns: the manifest without file contents. */
export const SkillSummaryResponse = Schema.Struct({
  owner: Owner,
  name: SkillName,
  description: Schema.String,
  frontmatter: Schema.Record(Schema.String, Schema.Unknown),
  files: Schema.Array(SkillFileEntryResponse),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
});

export const SkillResponse = Schema.Struct({
  ...SkillSummaryResponse.fields,
  files: Schema.Array(SkillFileResponse),
});

const SkillFileInputSchema = Schema.Struct({
  path: Schema.String,
  content: Schema.String,
});

/** Create or replace: the skill's name is read from `SKILL.md`. */
const SaveSkillPayload = Schema.Struct({
  owner: Owner,
  files: Schema.Array(SkillFileInputSchema),
});

/** What the user pasted: a GitHub repo, a path inside one, or a skills.sh link. */
const ImportSkillsPayload = Schema.Struct({
  source: Schema.String,
});

/** One skill found at the source, validated, with its files ready to save. */
const ImportedSkillCandidate = Schema.Struct({
  directory: Schema.String,
  name: SkillName,
  description: Schema.String,
  files: Schema.Array(SkillFileInputSchema),
});

export const ImportSkillsResponse = Schema.Struct({
  source: Schema.String,
  ref: Schema.String,
  skills: Schema.Array(ImportedSkillCandidate),
  rejected: Schema.Array(Schema.Struct({ directory: Schema.String, reason: Schema.String })),
  truncated: Schema.Boolean,
});

export const SkillsApi = HttpApiGroup.make("skills")
  .add(
    HttpApiEndpoint.get("list", "/skills", {
      success: Schema.Array(SkillSummaryResponse),
      error: InternalError,
    }),
  )
  .add(
    HttpApiEndpoint.get("get", "/skills/:owner/:name", {
      params: SkillParams,
      success: SkillResponse,
      error: [InternalError, SkillNotFoundError],
    }),
  )
  .add(
    HttpApiEndpoint.put("save", "/skills", {
      payload: SaveSkillPayload,
      success: SkillResponse,
      error: [InternalError, InvalidSkillError, OrgWriteDeniedError],
    }),
  )
  .add(
    // Read-only: fetches the repository and returns candidates. Saving what the
    // user picks goes through `save`, so import never writes on its own.
    HttpApiEndpoint.post("import", "/skills/import", {
      payload: ImportSkillsPayload,
      success: ImportSkillsResponse,
      error: [InternalError, SkillSourceError],
    }),
  )
  .add(
    HttpApiEndpoint.delete("remove", "/skills/:owner/:name", {
      params: SkillParams,
      success: Schema.Struct({ removed: Schema.Boolean }),
      error: [InternalError, OrgWriteDeniedError],
    }),
  );
