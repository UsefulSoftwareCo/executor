import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Schema } from "effect";
import {
  compareReleaseVersions,
  release,
  ReleaseVersion,
} from "../../../scripts/releases/config.ts";
import type { ReleaseNotes } from "./changelog.ts";
import { commands } from "./cli.ts";
import { generateReference } from "./generate.ts";
import { code } from "./markdown.ts";
import { decodeReferenceRelease, McpProfiles, referenceRelease } from "./release.ts";
import { analyticsImageSettings, imageSettings, readSelfHostSettings } from "./self-host.ts";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const run = (file: string, args: readonly string[], cwd = root) =>
  execFileSync(file, args, {
    cwd,
    encoding: "utf8",
    env: file === "gh" ? process.env : { ...process.env, GH_TOKEN: undefined, DO_NOT_TRACK: "1" },
    maxBuffer: 32 * 1024 * 1024,
  });

const GitHubRelease = Schema.Struct({
  tag_name: Schema.String,
  target_commitish: Schema.String,
  draft: Schema.Boolean,
  published_at: Schema.NullOr(Schema.String),
  body: Schema.NullOr(Schema.String),
});
const GitHubCommit = Schema.Struct({
  sha: Schema.String,
  commit: Schema.Struct({ message: Schema.String }),
});
const ImageConfig = Schema.Struct({
  config: Schema.Struct({
    Env: Schema.Array(Schema.String),
    Labels: Schema.Record(Schema.String, Schema.String),
  }),
});
const ImageIndex = Schema.Record(Schema.String, ImageConfig);
const readPackageVersion = (directory: string, manifest: string) =>
  Schema.decodeUnknownSync(Schema.Struct({ version: Schema.String }))(
    JSON.parse(readFileSync(join(directory, manifest), "utf8")),
  ).version;

function publishedHistory(version: typeof ReleaseVersion.Type) {
  const records = Schema.decodeUnknownSync(Schema.Array(Schema.Array(GitHubRelease)))(
    JSON.parse(
      run("gh", [
        "api",
        "--paginate",
        "--slurp",
        `repos/${release.repository}/releases?per_page=100`,
      ]),
    ),
  );
  return records
    .flat()
    .flatMap((record) => {
      const candidate = Schema.decodeUnknownOption(ReleaseVersion)(
        record.tag_name.replace(/^executor@/u, ""),
      );
      if (
        !record.tag_name.startsWith("executor@") ||
        candidate._tag === "None" ||
        record.draft ||
        record.published_at === null ||
        compareReleaseVersions(candidate.value, version) > 0
      )
        return [];
      return [{ ...record, version: candidate.value, publishedAt: record.published_at }];
    })
    .sort((left, right) => compareReleaseVersions(right.version, left.version));
}

function publishedNotes(
  history: ReturnType<typeof publishedHistory>,
  previous: readonly ReleaseNotes[],
): ReleaseNotes[] {
  const archived = new Map(previous.map(({ version, notes }) => [version, notes]));
  return history.map(({ version, body }, index) => {
    if (index === history.length - 1) {
      const announcement = body
        ?.split(/^## Build for review$/mu)[0]
        ?.replace(/^# .*\n/u, "")
        .trim();
      if (announcement) return { version, announcement, notes: [] };
    }
    const changes = body?.match(/^## Changes since [^\n]+\n([\s\S]*?)(?=^## |(?![\s\S]))/mu)?.[1];
    if (changes === undefined) return { version, notes: archived.get(version) ?? [] };
    let area = "";
    const notes = changes.split(/\r?\n/u).flatMap((line) => {
      if (line.startsWith("### ")) area = line.slice(4);
      return line.startsWith("- ") ? [{ area, text: line.slice(2) }] : [];
    });
    return { version, notes };
  });
}

function publishedImageDefaults(version: string, source: string) {
  const configs = Schema.decodeUnknownSync(ImageIndex)(
    JSON.parse(
      run("docker", [
        "buildx",
        "imagetools",
        "inspect",
        `${release.image}:${version}`,
        "--format",
        "{{json .Image}}",
      ]),
    ),
  );
  const defaults = ["linux/amd64", "linux/arm64"].map((platform) => {
    const config = configs[platform]?.config;
    if (config?.Labels["org.opencontainers.image.revision"] !== source)
      throw new Error(
        `The published image for ${version} on ${platform} does not name source ${source}`,
      );
    const env = new Map(
      config.Env.map((entry) => {
        const separator = entry.indexOf("=");
        return [entry.slice(0, separator), entry.slice(separator + 1)] as const;
      }),
    );
    return Object.fromEntries([
      ...imageSettings.flatMap((key) => {
        const value = env.get(key);
        return value === undefined ? [] : [[key, code(value)]];
      }),
      ...analyticsImageSettings.map((key) => [
        key,
        env.get(key) ? "Configured by the release build" : "Unset",
      ]),
    ]);
  });
  if (JSON.stringify(defaults[0]) !== JSON.stringify(defaults[1]))
    throw new Error("Self-host image defaults differ by architecture");
  return defaults[0]!;
}

const args = process.argv.slice(2);
const [versionArg] = args;
if (versionArg === undefined || args.length !== 1)
  throw new Error("Usage: bun apps/docs/reference/capture.ts <published-version>");

const version = Schema.decodeUnknownSync(ReleaseVersion)(versionArg);
const history = publishedHistory(version);
const published = history[0];
if (published?.version !== version) throw new Error(`No public release for Executor ${version}`);
const exported = Schema.decodeUnknownSync(GitHubCommit)(
  JSON.parse(
    run("gh", [
      "api",
      `repos/${release.repository}/commits/${encodeURIComponent(published.tag_name)}`,
    ]),
  ),
);
if (exported.sha !== published.target_commitish)
  throw new Error(`The public tag for Executor ${version} does not resolve to its release export`);
const abbreviation = /^Export ([0-9a-f]{7,40})$/u.exec(exported.commit.message.trim())?.[1];
if (abbreviation === undefined)
  throw new Error(`Cannot identify the source of export ${exported.sha}`);
const source = run("git", ["rev-parse", "--verify", `${abbreviation}^{commit}`]).trim();

const image = publishedImageDefaults(version, source);
const scratch = mkdtempSync(join(tmpdir(), "executor-docs-release-"));
try {
  const directory = join(scratch, "release");
  mkdirSync(directory);
  const archive = join(scratch, "release.tar");
  run("git", ["archive", "--output", archive, source]);
  run("tar", ["-xf", archive, "-C", directory]);
  const cliPackage = Schema.decodeUnknownSync(
    Schema.Struct({
      version: ReleaseVersion,
      engines: Schema.Struct({ node: Schema.String.check(Schema.isPattern(/^>=\d+\.\d+\.\d+$/u)) }),
    }),
  )(JSON.parse(readFileSync(join(directory, "apps/cli/package.json"), "utf8")));
  if (cliPackage.version !== version)
    throw new Error(`Release source ${source} does not declare Executor ${version}`);

  run(
    "bun",
    ["install", "--frozen-lockfile", "--ignore-scripts", "--filter", "@executor-js/local-server"],
    directory,
  );
  const bundle = "apps/local/server/src/docs-reference-cli.js";
  run(
    "bun",
    [
      "build",
      "apps/local/server/src/bin.ts",
      "--target=bun",
      "--packages=external",
      `--outfile=${bundle}`,
    ],
    directory,
  );
  const help: Record<string, string> = {};
  commands((path) => {
    const text = run("bun", [bundle, ...path, "--help"], directory);
    help[path.join(" ")] = text;
    return text;
  });
  const mcp = "apps/local/server/docs-reference-mcp.ts";
  copyFileSync(new URL("inspect-mcp.ts", import.meta.url), join(directory, mcp));
  const skills = join(directory, "packages/app-templates/executor/skills");
  const snapshot = decodeReferenceRelease({
    version,
    source,
    exportCommit: exported.sha,
    publishedAt: published.publishedAt,
    framework: readPackageVersion(directory, "packages/apps/package.json"),
    minimumNodeVersion: cliPackage.engines.node.slice(2),
    cli: help,
    mcp: Schema.decodeUnknownSync(McpProfiles)(JSON.parse(run("bun", [mcp], directory))),
    selfHost: readSelfHostSettings(directory, image),
    skills: Object.fromEntries(
      readdirSync(skills, { recursive: true, encoding: "utf8" })
        .filter((file) => file.endsWith(".md"))
        .sort()
        .map((file) => [
          file,
          readFileSync(join(skills, file), "utf8").replace(/<!--[^]*?-->/gu, ""),
        ]),
    ),
    notes: publishedNotes(history, referenceRelease.notes),
  });
  const snapshotFile = join(scratch, "release.json");
  writeFileSync(snapshotFile, `${JSON.stringify(snapshot, null, 2)}\n`);
  run("bun", ["x", "--no-install", "oxfmt", snapshotFile]);
  generateReference(snapshot, "update");
  copyFileSync(snapshotFile, new URL("release.json", import.meta.url));
  console.log(`Pinned Executor ${version}, source ${source}, export ${exported.sha}.`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
