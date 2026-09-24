import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rmdir,
  unlink,
} from "node:fs/promises";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { Option, Schema } from "effect";
import type { ManagedSkillId, Owner, SkillPackageDigest } from "@executor-js/sdk/shared";

export const SKILL_MARKER_FILENAME = ".executor-skill.json";

const Marker = Schema.Struct({
  version: Schema.Literal(1),
  origin: Schema.String,
  skillId: Schema.String,
  owner: Schema.Literals(["user", "org"]),
  name: Schema.String,
  revisionDigest: Schema.String,
  files: Schema.Record(Schema.String, Schema.String),
});
const decodeSkillMarker = Schema.decodeUnknownOption(Schema.fromJsonString(Marker));

export type SkillMarker = typeof Marker.Type;

export interface MaterializedSkill {
  readonly id: ManagedSkillId;
  readonly owner: Owner;
  readonly name: string;
  readonly revisionDigest: SkillPackageDigest;
  readonly files: readonly {
    readonly path: string;
    readonly digest: string;
    readonly bytes: Uint8Array;
  }[];
}

export interface MaterializeResult {
  readonly added: number;
  readonly updated: number;
  readonly unchanged: number;
  readonly removed: number;
  readonly skipped: readonly string[];
}

export const defaultAgentSkillsDirectory = (): string => join(homedir(), ".agents", "skills");
export const defaultClaudeSkillsDirectory = (): string => join(homedir(), ".claude", "skills");

export const parseSkillMarker = (raw: string): SkillMarker | null =>
  Option.getOrNull(decodeSkillMarker(raw));

const digest = (bytes: Uint8Array): string =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

const assertInside = (root: string, path: string): void => {
  const rel = relative(root, path);
  if (rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))) return;
  throw new Error(`Skill path escapes its target directory: ${path}`);
};

const lstatOrNull = async (path: string) => {
  try {
    return await lstat(path);
  } catch (cause) {
    if (typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT") {
      return null;
    }
    throw cause;
  }
};

const assertNoSymlinkComponents = async (path: string): Promise<void> => {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  const segments = absolute.slice(root.length).split(sep).filter(Boolean);
  let current = root;
  for (const segment of segments) {
    current = join(current, segment);
    const info = await lstatOrNull(current);
    if (info?.isSymbolicLink()) throw new Error(`Refusing symlinked skill path: ${current}`);
  }
};

const walkRegularFiles = async (root: string, current = root): Promise<readonly string[]> => {
  const entries = await readdir(current, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(current, entry.name);
    assertInside(root, path);
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error(`Refusing symlink inside managed skill: ${path}`);
    if (info.isDirectory()) files.push(...(await walkRegularFiles(root, path)));
    else if (info.isFile()) files.push(path);
    else throw new Error(`Refusing non-regular skill entry: ${path}`);
  }
  return files;
};

const ensureDirectory = async (path: string): Promise<void> => {
  await assertNoSymlinkComponents(dirname(path));
  await mkdir(path, { recursive: true, mode: 0o755 });
  await assertNoSymlinkComponents(path);
};

const readMarker = async (directory: string): Promise<SkillMarker | null> => {
  const markerPath = join(directory, SKILL_MARKER_FILENAME);
  const info = await lstatOrNull(markerPath);
  if (info === null || !info.isFile() || info.isSymbolicLink()) return null;
  return parseSkillMarker(await readFile(markerPath, "utf8"));
};

const currentDigest = async (path: string): Promise<string | null> => {
  const info = await lstatOrNull(path);
  if (info === null) return null;
  if (!info.isFile() || info.isSymbolicLink())
    throw new Error(`Refusing unsafe skill file: ${path}`);
  return digest(await readFile(path));
};

const removeRegularTree = async (root: string): Promise<void> => {
  const files = await walkRegularFiles(root);
  for (const file of files) await unlink(file);
  const directories: string[] = [];
  const collect = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const child = join(directory, entry.name);
      directories.push(child);
      await collect(child);
    }
  };
  await collect(root);
  for (const directory of directories.sort((a, b) => b.length - a.length)) await rmdir(directory);
  await rmdir(root);
};

const writeRegularFile = async (path: string, bytes: Uint8Array): Promise<void> => {
  await mkdir(dirname(path), { recursive: true, mode: 0o755 });
  const handle = await open(path, "wx", 0o644);
  try {
    await handle.writeFile(bytes);
  } finally {
    await handle.close();
  }
  await chmod(path, 0o644);
};

const materializeOne = async (input: {
  readonly root: string;
  readonly origin: string;
  readonly skill: MaterializedSkill;
  readonly force: boolean;
}): Promise<"added" | "updated" | "unchanged" | `skipped:${string}`> => {
  const destination = join(input.root, input.skill.name);
  assertInside(input.root, destination);
  const destinationInfo = await lstatOrNull(destination);
  if (destinationInfo?.isSymbolicLink()) return `skipped:${input.skill.name} is a symlink`;
  if (destinationInfo !== null && !destinationInfo.isDirectory()) {
    return `skipped:${input.skill.name} is not a directory`;
  }
  const existingMarker = destinationInfo === null ? null : await readMarker(destination);
  if (destinationInfo !== null && existingMarker === null) {
    return `skipped:${input.skill.name} is not managed by Executor`;
  }
  if (existingMarker !== null && existingMarker.origin !== input.origin) {
    return `skipped:${input.skill.name} belongs to another Executor server`;
  }
  const desiredFiles = Object.fromEntries(
    input.skill.files.map((file) => [file.path, file.digest]),
  );
  if (
    existingMarker !== null &&
    existingMarker.skillId === input.skill.id &&
    existingMarker.revisionDigest === input.skill.revisionDigest &&
    Object.entries(desiredFiles).every(
      ([path, expected]) => existingMarker.files[path] === expected,
    )
  ) {
    const unchanged = await Promise.all(
      Object.entries(existingMarker.files).map(
        async ([path, expected]) => (await currentDigest(join(destination, path))) === expected,
      ),
    );
    if (unchanged.every(Boolean)) return "unchanged";
  }
  if (existingMarker !== null && !input.force) {
    const drift = await Promise.all(
      Object.entries(existingMarker.files).map(async ([path, expected]) => ({
        path,
        changed: (await currentDigest(join(destination, path))) !== expected,
      })),
    );
    const changed = drift.filter((entry) => entry.changed).map((entry) => entry.path);
    if (changed.length > 0)
      return `skipped:${input.skill.name} has local changes: ${changed.join(", ")}`;
  }

  await ensureDirectory(input.root);
  const temporary = join(input.root, `.${input.skill.name}.executor-${randomUUID()}.tmp`);
  const backup = join(input.root, `.${input.skill.name}.executor-${randomUUID()}.bak`);
  await mkdir(temporary, { mode: 0o755 });
  if (destinationInfo !== null) {
    for (const path of await walkRegularFiles(destination)) {
      const relativePath = relative(destination, path);
      if (relativePath === SKILL_MARKER_FILENAME || desiredFiles[relativePath] !== undefined)
        continue;
      const target = join(temporary, relativePath);
      assertInside(temporary, target);
      await mkdir(dirname(target), { recursive: true, mode: 0o755 });
      await copyFile(path, target);
      await chmod(target, 0o644);
    }
  }
  for (const file of input.skill.files) {
    const target = join(temporary, file.path);
    assertInside(temporary, target);
    await writeRegularFile(target, file.bytes);
  }
  const marker: SkillMarker = {
    version: 1,
    origin: input.origin,
    skillId: String(input.skill.id),
    owner: input.skill.owner,
    name: input.skill.name,
    revisionDigest: String(input.skill.revisionDigest),
    files: desiredFiles,
  };
  await writeRegularFile(
    join(temporary, SKILL_MARKER_FILENAME),
    new TextEncoder().encode(`${JSON.stringify(marker, null, 2)}\n`),
  );
  if (destinationInfo !== null) await rename(destination, backup);
  try {
    await rename(temporary, destination);
  } catch (cause) {
    if (destinationInfo !== null) await rename(backup, destination);
    throw cause;
  }
  if (destinationInfo !== null) await removeRegularTree(backup);
  return destinationInfo === null ? "added" : "updated";
};

const removeStaleSkill = async (input: {
  readonly root: string;
  readonly directory: string;
  readonly marker: SkillMarker;
  readonly origin: string;
}): Promise<boolean> => {
  if (input.marker.origin !== input.origin) return false;
  for (const [path, expected] of Object.entries(input.marker.files)) {
    const target = join(input.directory, path);
    assertInside(input.directory, target);
    if ((await currentDigest(target)) === expected) await unlink(target);
  }
  await unlink(join(input.directory, SKILL_MARKER_FILENAME));
  const directories = (await walkRegularFiles(input.directory)).map(dirname);
  for (const directory of [...new Set(directories)].sort((a, b) => b.length - a.length)) {
    await rmdir(directory).catch(() => undefined);
  }
  await rmdir(input.directory).catch(() => undefined);
  return true;
};

export const materializeSkills = async (input: {
  readonly root: string;
  readonly origin: string;
  readonly skills: readonly MaterializedSkill[];
  readonly force: boolean;
}): Promise<MaterializeResult> => {
  const root = resolve(input.root);
  await ensureDirectory(root);
  const effective = new Map<string, MaterializedSkill>();
  for (const skill of input.skills) {
    const current = effective.get(skill.name);
    if (!current || (current.owner === "org" && skill.owner === "user"))
      effective.set(skill.name, skill);
  }
  let added = 0;
  let updated = 0;
  let unchanged = 0;
  let removed = 0;
  const skipped: string[] = [];
  for (const skill of effective.values()) {
    const result = await materializeOne({ ...input, root, skill });
    if (result === "added") added += 1;
    else if (result === "updated") updated += 1;
    else if (result === "unchanged") unchanged += 1;
    else skipped.push(result.slice("skipped:".length));
  }
  for (const name of await readdir(root)) {
    if (effective.has(name) || name.startsWith(".")) continue;
    const directory = join(root, name);
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) continue;
    const marker = await readMarker(directory);
    if (
      marker !== null &&
      (await removeStaleSkill({ root, directory, marker, origin: input.origin }))
    ) {
      removed += 1;
    }
  }
  return { added, updated, unchanged, removed, skipped };
};
