import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Effect } from "effect";
import ts from "typescript-5";
import { SourceFiles } from "@executor-js/sdk/core";
import {
  applyEdits,
  compareReleases,
  scopedIndexEdits,
  type ScopedEdit,
  declaredRelease,
  scopedRequirementsRelease,
  sourceDigest,
  upgradedFiles,
} from "../packages/app-management/src/implementation/catalog-copy-upgrade.ts";
import { catalogCopyRebuildTargetRelease } from "../packages/app-management/src/contracts/catalog-copy-rebuild.ts";

const root = new URL("..", import.meta.url).pathname;
const output = join(root, "packages/app-management/src/implementation/catalog-copy-snapshots.ts");

const argument = (name: string) => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
};
const catalog = argument("catalog");
const commitsFile = argument("commits");
const reviewed = argument("reviewed");
const statsFile = argument("stats");
const dump = argument("dump");
if (catalog === undefined || commitsFile === undefined || reviewed === undefined) {
  console.error(
    "Usage: bun scripts/catalog-copy-snapshots.ts --catalog <dir> --commits <file> --reviewed <before>:<after> [--stats <file>]",
  );
  process.exit(2);
}
const [reviewedBefore, reviewedAfter] = reviewed.split(":");
if (reviewedBefore === undefined || reviewedAfter === undefined) process.exit(2);

const git = (...args: string[]) => {
  const result = spawnSync("git", ["-C", catalog, ...args], {
    encoding: "utf8",
    maxBuffer: 1 << 30,
  });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
};

const readBlobs = (shas: ReadonlyArray<string>) => {
  const result = spawnSync("git", ["-C", catalog, "cat-file", "--batch"], {
    input: `${shas.join("\n")}\n`,
    maxBuffer: 2 ** 31,
  });
  if (result.status !== 0) throw new Error("git cat-file failed");
  const out = result.stdout;
  const blobs = new Map<string, Uint8Array>();
  let offset = 0;
  while (offset < out.length) {
    const newline = out.indexOf(10, offset);
    const [sha, type, size] = out.subarray(offset, newline).toString("utf8").split(" ");
    if (type !== "blob" || sha === undefined || size === undefined)
      throw new Error(`unexpected object ${sha} ${type}`);
    const start = newline + 1;
    blobs.set(sha, out.subarray(start, start + Number(size)));
    offset = start + Number(size) + 1;
  }
  return blobs;
};

const decoder = new TextDecoder("utf-8", { fatal: true });
const ignored = (path: string) =>
  path.split("/").some((part) => part === "node_modules" || part === ".DS_Store");

const packageTrees = (commits: ReadonlyArray<string>) => {
  const trees = new Map<string, string>();
  for (const commit of commits)
    for (const line of git("ls-tree", commit, "packages/").split("\n")) {
      const match = /^040000 tree ([0-9a-f]+)\tpackages\/(.+)$/u.exec(line);
      if (match !== null) trees.set(match[1]!, match[2]!);
    }
  return trees;
};

const treeFiles = (tree: string, pkg: string, blobs: Map<string, Uint8Array>) => {
  const entries = git("ls-tree", "-r", tree)
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      const [meta, path] = line.split("\t");
      const [, , sha] = meta!.split(" ");
      return { path: path!, sha: sha! };
    })
    .filter((entry) => !ignored(entry.path))
    .toSorted((left, right) => (left.path < right.path ? -1 : 1));
  const missing = entries.filter((entry) => !blobs.has(entry.sha)).map((entry) => entry.sha);
  if (missing.length > 0) for (const [sha, bytes] of readBlobs(missing)) blobs.set(sha, bytes);
  const files = entries.map((entry) => ({
    path: entry.path,
    content: decoder.decode(blobs.get(entry.sha)),
  }));
  if (!files.some((file) => file.path === "index.ts")) return undefined;
  const manifest = files.find((file) => file.path === "package.json");
  if (manifest === undefined) return undefined;
  const parsed = JSON.parse(manifest.content) as {
    name?: string;
    executor?: { title?: string };
  };
  if (parsed.name !== `@executor.sh/${pkg}` || !parsed.executor?.title) return undefined;
  return SourceFiles.make(files as [(typeof files)[number], ...typeof files]);
};

const scripts = (files: SourceFiles) =>
  files.filter((file) => /\.(?:[cm]?[jt]sx?)$/u.test(file.path) && "content" in file);

const accountsIdentifiers = (text: string) => {
  const source = ts.createSourceFile(
    "index.ts",
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const found: Array<{ readonly start: number; readonly role: "read" | "property" | "other" }> = [];
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node) && node.text === "accounts") {
      const parent = node.parent;
      const role =
        ts.isPropertyAccessExpression(parent) && parent.expression === node
          ? ("read" as const)
          : (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
              ((ts.isPropertyAssignment(parent) ||
                ts.isPropertySignature(parent) ||
                ts.isMethodDeclaration(parent) ||
                ts.isPropertyDeclaration(parent)) &&
                parent.name === node)
            ? ("property" as const)
            : ("other" as const);
      found.push({ start: node.getStart(source), role });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
};

const readsResolve = (original: string, upgraded: string) => {
  const edits = scopedIndexEdits(original);
  if (edits === undefined) return false;
  const before = new Map(accountsIdentifiers(original).map((entry) => [entry.start, entry.role]));
  if (edits.some((edit) => edit.kind === "read" && before.get(edit.start) !== "read")) return false;
  return accountsIdentifiers(upgraded).every((entry) => entry.role === "property");
};

const parses = (path: string, text: string) => {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  return (
    (source as unknown as { parseDiagnostics: ReadonlyArray<unknown> }).parseDiagnostics.length ===
    0
  );
};

const codemodStyle = (original: string) => {
  const edits = scopedIndexEdits(original);
  if (edits === undefined) return undefined;
  const declaration = edits.filter((edit) => edit.kind === "declaration");
  const opened = declaration[0];
  const closed = declaration[1];
  if (opened === undefined || closed === undefined) return undefined;
  const value = original.slice(opened.start, closed.start);
  const empty = /^accounts\s*:\s*\{\s*\}$/u.test(value);
  const styled = edits.flatMap((edit): ScopedEdit[] => {
    if (edit.kind === "read") return [];
    if (edit.kind === "binding") return [{ ...edit, text: "user: { accounts }" }];
    if (!empty) return [edit];
    if (edit !== opened) return [];
    const after = /^,\s*/u.exec(original.slice(closed.start));
    if (after !== null) return [{ ...edit, end: closed.start + after[0].length, text: "" }];
    const before = /,\s*$/u.exec(original.slice(0, opened.start));
    if (before !== null) return [{ ...edit, start: before.index, end: closed.start, text: "" }];
    const open = /\{\s*$/u.exec(original.slice(0, opened.start));
    const close = /^\s*\}/u.exec(original.slice(closed.start));
    if (open === null || close === null) return [edit];
    return [{ ...edit, start: open.index + 1, end: closed.start + close[0].length - 1, text: "" }];
  });
  return applyEdits(original, styled);
};

const commits = readFileSync(commitsFile, "utf8")
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line !== "" && !line.startsWith("#"));
const trees = packageTrees(commits);
const blobs = new Map<string, Uint8Array>();
const work = mkdtempSync(join(tmpdir(), "catalog-copy-snapshots-"));

type Candidate = {
  readonly pkg: string;
  readonly tree: string;
  readonly from: string;
  readonly files: SourceFiles;
  readonly upgraded: SourceFiles;
};
const stats = {
  commits: commits.length,
  trees: trees.size,
  feedSkipped: 0,
  byRelease: {} as Record<string, number>,
  current: 0,
  notRecognized: 0,
  codemodDisagrees: 0,
  doesNotParse: 0,
  readsUnresolved: 0,
  readsUnresolvedPackages: [] as string[],
  listed: 0,
  reviewedCompared: 0,
  reviewedEqual: 0,
  reviewedDiffer: [] as string[],
  notReviewed: 0,
  notRecognizedPackages: [] as string[],
  codemodPackages: [] as string[],
};
const candidates: Candidate[] = [];
for (const [tree, pkg] of trees) {
  const files = treeFiles(tree, pkg, blobs);
  if (files === undefined) {
    stats.feedSkipped++;
    continue;
  }
  const from = declaredRelease(files) ?? "none";
  stats.byRelease[from] = (stats.byRelease[from] ?? 0) + 1;
  const order = compareReleases(from, catalogCopyRebuildTargetRelease);
  if (order !== undefined && order >= 0) {
    stats.current++;
    continue;
  }
  const upgraded = upgradedFiles(files, catalogCopyRebuildTargetRelease);
  if (upgraded === undefined) {
    stats.notRecognized++;
    stats.notRecognizedPackages.push(`${pkg}@${from}`);
    continue;
  }
  candidates.push({ pkg, tree, from, files, upgraded });
}

const scoped = candidates.filter(
  (candidate) => (compareReleases(candidate.from, scopedRequirementsRelease) ?? 0) < 0,
);
for (const candidate of scoped)
  for (const file of scripts(candidate.files)) {
    const path = join(work, candidate.tree, file.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "content" in file ? file.content : "");
  }
if (scoped.length > 0) {
  const codemod = spawnSync("node", [join(root, "scripts/codemods/app-user-accounts.ts"), work], {
    encoding: "utf8",
    maxBuffer: 1 << 30,
  });
  if (codemod.status !== 0) throw new Error(`codemod failed: ${codemod.stderr}`);
}
const disagrees = new Set<string>();
for (const candidate of scoped)
  for (const file of scripts(candidate.files)) {
    if (!("content" in file) || "encoding" in file) continue;
    const written = readFileSync(join(work, candidate.tree, file.path), "utf8");
    const upgraded = candidate.upgraded.find((entry) => entry.path === file.path);
    const expected =
      file.path === "index.ts" && upgraded !== undefined && "content" in upgraded
        ? (codemodStyle(file.content) ?? file.content)
        : file.content;
    if (written !== expected) {
      disagrees.add(candidate.tree);
      if (dump !== undefined) {
        const folder = join(dump, `${candidate.pkg}-${candidate.tree.slice(0, 8)}`);
        mkdirSync(folder, { recursive: true });
        writeFileSync(join(folder, `${file.path.replaceAll("/", "_")}.codemod`), written);
        writeFileSync(join(folder, `${file.path.replaceAll("/", "_")}.expected`), expected);
      }
    }
  }
rmSync(work, { recursive: true, force: true });

const reviewedTrees = packageTrees([reviewedBefore]);
const afterIndex = (pkg: string) => {
  const sha = git("ls-tree", reviewedAfter, `packages/${pkg}/index.ts`).split(/\s+/u)[2];
  return sha === undefined || sha === "" ? undefined : decoder.decode(readBlobs([sha]).get(sha));
};
const movedMore = new Set(
  git("diff", "--name-only", reviewedBefore, reviewedAfter, "--", "packages")
    .split("\n")
    .filter((path) => path !== "" && !/\/(?:index\.ts|package\.json)$/u.test(path))
    .map((path) => path.split("/")[1] ?? ""),
);
const reviewedPackages = new Set(reviewedTrees.values());
const movedDifferently = new Set<string>(movedMore);
for (const [tree, pkg] of reviewedTrees) {
  const before = treeFiles(tree, pkg, blobs);
  const upgraded =
    before === undefined ? undefined : upgradedFiles(before, catalogCopyRebuildTargetRelease);
  const index = upgraded?.find((file) => file.path === "index.ts");
  const expected = afterIndex(pkg);
  stats.reviewedCompared++;
  if (index !== undefined && "content" in index && index.content === expected)
    stats.reviewedEqual++;
  else movedDifferently.add(pkg);
}
stats.reviewedDiffer = [...movedDifferently].toSorted();

const targets = new Set<string>();
for (const candidate of candidates) {
  if (disagrees.has(candidate.tree)) {
    stats.codemodDisagrees++;
    stats.codemodPackages.push(`${candidate.pkg}@${candidate.from}`);
    continue;
  }
  if (
    !scripts(candidate.upgraded).every(
      (file) => !("content" in file) || "encoding" in file || parses(file.path, file.content),
    )
  ) {
    stats.doesNotParse++;
    continue;
  }
  if ((compareReleases(candidate.from, scopedRequirementsRelease) ?? 0) < 0) {
    const original = candidate.files.find((file) => file.path === "index.ts");
    const upgraded = candidate.upgraded.find((file) => file.path === "index.ts");
    if (
      original === undefined ||
      upgraded === undefined ||
      !("content" in original) ||
      !("content" in upgraded) ||
      !readsResolve(original.content, upgraded.content)
    ) {
      stats.readsUnresolved++;
      stats.readsUnresolvedPackages.push(`${candidate.pkg}@${candidate.from}`);
      continue;
    }
  }
  if (
    (compareReleases(candidate.from, scopedRequirementsRelease) ?? 0) < 0 &&
    (movedDifferently.has(candidate.pkg) || !reviewedPackages.has(candidate.pkg))
  ) {
    stats.notReviewed++;
    continue;
  }
  targets.add(await Effect.runPromise(sourceDigest(candidate.upgraded)));
  stats.listed++;
}

const sorted = [...targets].toSorted();
const lines: string[] = [];
for (let index = 0; index < sorted.length; index += 8)
  lines.push(sorted.slice(index, index + 8).join(" "));
writeFileSync(
  output,
  `/**
 * Generated by scripts/catalog-copy-snapshots.ts; do not edit. The reviewed targets of the
 * catalog-copy rebuild: the digest (\`sourceDigest\`) of each published catalog package tree before
 * ${catalogCopyRebuildTargetRelease}, upgraded by \`upgradedFiles\`. A copy whose upgraded files have
 * another digest is not rebuilt.
 *
 * Catalog commits read: ${stats.commits}. Package trees: ${stats.trees}. Listed: ${stats.listed},
 * as ${sorted.length} distinct targets (trees that differ only in their pin share one).
 * Packages whose own move to beta.100 (${reviewedBefore} to ${reviewedAfter}) was exactly the upgrade:
 * ${stats.reviewedEqual} of ${stats.reviewedCompared}; the older trees of the other packages are not listed.
 */
const packed = \`
${lines.join("\n")}
\`;

export const catalogCopyTargets: ReadonlySet<string> = new Set(
  packed.split(/\\s+/u).filter((digest) => digest !== ""),
);
`,
);
if (statsFile !== undefined) writeFileSync(statsFile, `${JSON.stringify(stats, null, 2)}\n`);
console.log(
  JSON.stringify({
    ...stats,
    notRecognizedPackages: undefined,
    codemodPackages: undefined,
    readsUnresolvedPackages: undefined,
  }),
);
