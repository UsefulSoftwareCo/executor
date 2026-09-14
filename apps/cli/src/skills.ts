import { homedir } from "node:os";
import { FileSystem, Path } from "effect";
import type { PlatformError } from "effect/PlatformError";
import * as Effect from "effect/Effect";

import type { Owner } from "@executor-js/sdk/shared";

// ---------------------------------------------------------------------------
// `executor skills` — list and pull Agent Skills from the connected server.
//
// Pure planning lives here, separated from the filesystem/network I/O that
// drives it, so the marker-file safety rules (never touch a directory that
// isn't ours) are unit-testable without a server or real disk writes. See
// plans/agent-skills.md, "CLI (apps/cli)" for the contract, and
// packages/core/api/src/skills/api.ts for the response shapes this mirrors.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Types mirroring the skills HTTP API responses.
// ---------------------------------------------------------------------------

export interface SkillFileEntry {
  readonly path: string;
  readonly size: number;
  readonly digest: string;
}

export interface SkillFile extends SkillFileEntry {
  readonly content: string;
}

/** What `GET /skills` returns per skill: the manifest, no file contents. */
export interface SkillSummary {
  readonly owner: Owner;
  readonly name: string;
  readonly description: string;
  readonly files: readonly SkillFileEntry[];
  readonly updatedAt: number;
}

/** What `GET /skills/:owner/:name` returns: the summary plus file contents. */
export interface SkillDetail extends Omit<SkillSummary, "files"> {
  readonly files: readonly SkillFile[];
}

// ---------------------------------------------------------------------------
// Default install locations
// ---------------------------------------------------------------------------

export const defaultSkillsDir = (): string => `${homedir()}/.agents/skills`;
export const defaultClaudeSkillsDir = (): string => `${homedir()}/.claude/skills`;

// ---------------------------------------------------------------------------
// Owner shadowing: a `user` skill hides an `org` skill of the same name.
// ---------------------------------------------------------------------------

/** Resolve the set of skills every agent actually sees: at most one entry per
 *  name, preferring the `user` (personal) copy over an `org` (workspace) one. */
export const resolveEffectiveSkills = <S extends { readonly owner: Owner; readonly name: string }>(
  skills: readonly S[],
): readonly S[] => {
  const byName = new Map<string, S>();
  for (const skill of skills) {
    const existing = byName.get(skill.name);
    if (!existing || (existing.owner === "org" && skill.owner === "user")) {
      byName.set(skill.name, skill);
    }
  }
  return Array.from(byName.values());
};

// ---------------------------------------------------------------------------
// `list` — table formatting (pure).
// ---------------------------------------------------------------------------

export const formatSkillsTable = (skills: readonly SkillSummary[]): readonly string[] => {
  if (skills.length === 0) {
    return ["No skills found."];
  }

  const header = {
    owner: "OWNER",
    name: "NAME",
    description: "DESCRIPTION",
    files: "FILES",
    updated: "UPDATED",
  };
  const rows = skills.map((skill) => ({
    owner: skill.owner,
    name: skill.name,
    description: skill.description,
    files: String(skill.files.length),
    updated: new Date(skill.updatedAt).toISOString(),
  }));

  const widthOf = (key: "owner" | "name" | "files"): number =>
    Math.max(header[key].length, ...rows.map((row) => row[key].length));
  const ownerWidth = widthOf("owner");
  const nameWidth = widthOf("name");
  const filesWidth = widthOf("files");

  const line = (row: (typeof rows)[number] | typeof header): string =>
    `${row.owner.padEnd(ownerWidth)}  ${row.name.padEnd(nameWidth)}  ${row.description}  ${row.files.padEnd(filesWidth)}  ${row.updated}`;

  return [line(header), ...rows.map(line)];
};

// ---------------------------------------------------------------------------
// Marker file — `.executor-skill.json`, written into every skill directory
// this CLI manages. Its presence (and matching `origin`) is the only thing
// that authorizes `pull` to overwrite or delete a directory.
// ---------------------------------------------------------------------------

export const SKILL_MARKER_FILENAME = ".executor-skill.json";

export interface SkillMarker {
  readonly origin: string;
  readonly owner: Owner;
  readonly name: string;
  /** File path (relative to the skill root) -> digest, as last written. */
  readonly digests: Readonly<Record<string, string>>;
}

const isOwner = (value: unknown): value is Owner => value === "org" || value === "user";

/** Parse a marker file's contents. Returns `undefined` for anything that
 *  isn't a well-formed marker — including a directory some other tool made,
 *  which must never be treated as ours. */
export const parseSkillMarker = (raw: string): SkillMarker | undefined => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const candidate = parsed as Record<string, unknown>;
  if (typeof candidate.origin !== "string") return undefined;
  if (!isOwner(candidate.owner)) return undefined;
  if (typeof candidate.name !== "string") return undefined;
  if (typeof candidate.digests !== "object" || candidate.digests === null) return undefined;

  const digests: Record<string, string> = {};
  for (const [path, digest] of Object.entries(candidate.digests as Record<string, unknown>)) {
    if (typeof digest !== "string") return undefined;
    digests[path] = digest;
  }

  return { origin: candidate.origin, owner: candidate.owner, name: candidate.name, digests };
};

export const serializeSkillMarker = (marker: SkillMarker): string =>
  `${JSON.stringify(marker, null, 2)}\n`;

export const skillMarkerFor = (input: {
  readonly origin: string;
  readonly skill: Pick<SkillSummary, "owner" | "name">;
  readonly files: readonly SkillFileEntry[];
}): SkillMarker => ({
  origin: input.origin,
  owner: input.skill.owner,
  name: input.skill.name,
  digests: Object.fromEntries(input.files.map((file) => [file.path, file.digest])),
});

// ---------------------------------------------------------------------------
// `pull` — planning (pure). Decides add/update/unchanged/remove/skip per
// skill directory without touching the network or filesystem.
// ---------------------------------------------------------------------------

export type SkillPullActionKind = "add" | "update" | "unchanged" | "remove" | "skip";

export interface SkillPullAction {
  readonly name: string;
  readonly kind: SkillPullActionKind;
  readonly reason?: string;
}

/** What `pull` found on disk for one directory entry under the target root. */
export interface ExistingSkillEntry {
  readonly name: string;
  /** `undefined` when there's no marker file, or it doesn't parse: an
   *  unmanaged directory that `pull` must never overwrite or delete. */
  readonly marker: SkillMarker | undefined;
}

const digestsEqual = (
  a: Readonly<Record<string, string>>,
  b: Readonly<Record<string, string>>,
): boolean => {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) => a[key] === b[key]);
};

/** Plan one target root's worth of `pull` actions. Call once per root (the
 *  main `--dir` and, unless `--no-claude`, the `~/.claude/skills` mirror). */
export const planSkillsPull = (input: {
  readonly origin: string;
  /** Effective (already-shadowed) skills this owner scope can see. */
  readonly skills: readonly SkillSummary[];
  /** What's already on disk under the target root. */
  readonly existing: readonly ExistingSkillEntry[];
}): readonly SkillPullAction[] => {
  const actions: SkillPullAction[] = [];
  const skillNames = new Set(input.skills.map((skill) => skill.name));
  const existingByName = new Map(input.existing.map((entry) => [entry.name, entry]));

  for (const skill of input.skills) {
    const existing = existingByName.get(skill.name);
    const desiredDigests = Object.fromEntries(skill.files.map((file) => [file.path, file.digest]));

    if (!existing) {
      actions.push({ name: skill.name, kind: "add" });
      continue;
    }
    if (!existing.marker) {
      actions.push({
        name: skill.name,
        kind: "skip",
        reason: `${skill.name}/ exists without a ${SKILL_MARKER_FILENAME} marker`,
      });
      continue;
    }
    if (existing.marker.origin !== input.origin) {
      actions.push({
        name: skill.name,
        kind: "skip",
        reason: `${skill.name}/ is managed by a different server (${existing.marker.origin})`,
      });
      continue;
    }
    actions.push({
      name: skill.name,
      kind: digestsEqual(existing.marker.digests, desiredDigests) ? "unchanged" : "update",
    });
  }

  for (const existing of input.existing) {
    if (skillNames.has(existing.name)) continue;
    if (!existing.marker) continue; // never touch a directory we don't own
    if (existing.marker.origin !== input.origin) continue; // owned by another server
    actions.push({ name: existing.name, kind: "remove", reason: "no longer exists upstream" });
  }

  return actions;
};

export interface SkillPullSummary {
  readonly added: number;
  readonly updated: number;
  readonly unchanged: number;
  readonly removed: number;
  readonly skipped: number;
}

export const summarizeSkillPullActions = (
  actions: readonly SkillPullAction[],
): SkillPullSummary => ({
  added: actions.filter((action) => action.kind === "add").length,
  updated: actions.filter((action) => action.kind === "update").length,
  unchanged: actions.filter((action) => action.kind === "unchanged").length,
  removed: actions.filter((action) => action.kind === "remove").length,
  skipped: actions.filter((action) => action.kind === "skip").length,
});

export const formatSkillPullSummaryLine = (summary: SkillPullSummary): string =>
  `${summary.added} added, ${summary.updated} updated, ${summary.removed} removed, ${summary.skipped} skipped` +
  (summary.unchanged > 0 ? ` (${summary.unchanged} unchanged)` : "");

// ---------------------------------------------------------------------------
// Filesystem I/O — reading what's on disk and applying a plan. Kept small and
// separate from the planning above so tests can exercise the pure logic
// without a real (or even temp) filesystem; only the handful of tests that
// need real directory semantics use a temp dir.
// ---------------------------------------------------------------------------

/** List the immediate subdirectories of `root` and read each one's marker,
 *  if any. Returns `[]` when `root` doesn't exist yet. */
export const readExistingSkillEntries = (
  root: string,
): Effect.Effect<readonly ExistingSkillEntry[], PlatformError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const rootExists = yield* fs.exists(root);
    if (!rootExists) return [];

    const entries = yield* fs.readDirectory(root);
    const results: ExistingSkillEntry[] = [];
    for (const name of entries) {
      const entryPath = path.join(root, name);
      const info = yield* fs.stat(entryPath);
      if (info.type !== "Directory") continue;

      const markerPath = path.join(entryPath, SKILL_MARKER_FILENAME);
      const hasMarker = yield* fs.exists(markerPath);
      if (!hasMarker) {
        results.push({ name, marker: undefined });
        continue;
      }
      const raw = yield* fs.readFileString(markerPath).pipe(Effect.orElseSucceed(() => ""));
      results.push({ name, marker: parseSkillMarker(raw) });
    }
    return results;
  });

/** Write one skill's files (and its marker) into `<root>/<name>`, creating
 *  parent directories for nested file paths as needed. */
export const writeSkillDirectory = (input: {
  readonly root: string;
  readonly origin: string;
  readonly skill: SkillDetail;
}): Effect.Effect<void, PlatformError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const skillDir = path.join(input.root, input.skill.name);

    yield* fs.makeDirectory(skillDir, { recursive: true });
    for (const file of input.skill.files) {
      const filePath = path.join(skillDir, file.path);
      const parent = path.dirname(filePath);
      if (parent !== skillDir) {
        yield* fs.makeDirectory(parent, { recursive: true });
      }
      yield* fs.writeFileString(filePath, file.content);
    }

    const marker = skillMarkerFor({
      origin: input.origin,
      skill: input.skill,
      files: input.skill.files,
    });
    yield* fs.writeFileString(
      path.join(skillDir, SKILL_MARKER_FILENAME),
      serializeSkillMarker(marker),
    );
  });

/** Remove `<root>/<name>` entirely. Only called for `"remove"` actions, which
 *  `planSkillsPull` only ever produces for marker-bearing directories whose
 *  marker origin matches the current server. */
export const removeSkillDirectory = (
  root: string,
  name: string,
): Effect.Effect<void, PlatformError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.remove(path.join(root, name), { recursive: true, force: true });
  });
