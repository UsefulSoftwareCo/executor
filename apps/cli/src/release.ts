import { existsSync } from "node:fs";
import { mkdir, readdir, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type ReleaseChannel = "latest" | "beta";

type ReleaseCliOptions = {
  readonly dryRun: boolean;
};

type CommandInput = {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly captureOutput?: boolean;
};

type CommandOutput = {
  readonly stdout: string;
  readonly stderr: string;
};

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const cliRoot = resolve(repoRoot, "apps/cli");
const distDir = resolve(cliRoot, "dist");
const releaseDir = resolve(distDir, "release");
const wrapperDir = resolve(distDir, "executor");
const versionPackagePath = resolve(cliRoot, "package.json");
const semverPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

const parseArgs = (argv: ReadonlyArray<string>): ReleaseCliOptions => {
  let dryRun = false;

  for (const arg of argv) {
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return { dryRun };
};

const runCommand = async (input: CommandInput): Promise<CommandOutput> => {
  const proc = Bun.spawn([input.command, ...input.args], {
    cwd: input.cwd,
    env: process.env,
    stdio: input.captureOutput ? ["ignore", "pipe", "pipe"] : ["ignore", "inherit", "inherit"],
  });

  const exitCode = await proc.exited;
  const stdout = input.captureOutput && proc.stdout ? await new Response(proc.stdout).text() : "";
  const stderr = input.captureOutput && proc.stderr ? await new Response(proc.stderr).text() : "";

  if (exitCode !== 0) {
    throw new Error(
      [
        `${input.command} ${input.args.join(" ")} exited with code ${exitCode}`,
        stdout.trim().length > 0 ? `stdout:\n${stdout.trim()}` : null,
        stderr.trim().length > 0 ? `stderr:\n${stderr.trim()}` : null,
      ]
        .filter((part) => part !== null)
        .join("\n\n"),
    );
  }

  return {
    stdout: stdout.trim(),
    stderr: stderr.trim(),
  };
};

const readVersion = async (): Promise<string> => {
  const pkg = (await Bun.file(versionPackagePath).json()) as { version?: string };
  const version = pkg.version?.trim();

  if (!version) {
    throw new Error(`Missing version in ${versionPackagePath}`);
  }

  return version;
};

const validateVersion = (version: string): void => {
  if (!semverPattern.test(version)) {
    throw new Error(`${versionPackagePath} version is not valid semver: ${version}`);
  }
};

const resolveChannel = (version: string): ReleaseChannel =>
  version.includes("-") ? "beta" : "latest";

const resolveTagFromEnvironment = (): string | undefined => {
  const refName = process.env.GITHUB_REF_NAME?.trim();
  if (process.env.GITHUB_REF_TYPE === "tag" && refName) {
    return refName;
  }

  const ref = process.env.GITHUB_REF?.trim();
  if (ref?.startsWith("refs/tags/")) {
    return ref.slice("refs/tags/".length);
  }

  return undefined;
};

const resolveGitHubRepository = (): string => {
  const repository = process.env.GH_REPO?.trim() || process.env.GITHUB_REPOSITORY?.trim();
  if (!repository) {
    throw new Error("Set GH_REPO or GITHUB_REPOSITORY before creating a GitHub release.");
  }

  return repository;
};

const packWrapperPackage = async (): Promise<string> => {
  if (!existsSync(wrapperDir)) {
    throw new Error(`Wrapper package directory not found: ${wrapperDir}`);
  }

  await mkdir(releaseDir, { recursive: true });

  const before = new Set((await readdir(wrapperDir)).filter((entry) => entry.endsWith(".tgz")));
  await runCommand({
    command: "bun",
    args: ["pm", "pack"],
    cwd: wrapperDir,
  });

  const after = (await readdir(wrapperDir)).filter((entry) => entry.endsWith(".tgz"));
  const archiveName = after.find((entry) => !before.has(entry)) ?? after[0];

  if (!archiveName) {
    throw new Error(`bun pm pack did not create a .tgz archive in ${wrapperDir}`);
  }

  const sourcePath = join(wrapperDir, archiveName);
  const destinationPath = join(releaseDir, archiveName);

  await rm(destinationPath, { force: true });
  await rename(sourcePath, destinationPath);

  return destinationPath;
};

const collectReleaseAssetPaths = async (
  wrapperArchivePath: string,
): Promise<ReadonlyArray<string>> => {
  const assetNames = (await readdir(distDir))
    .filter((entry) => /^executor-.*\.(?:tar\.gz|zip)$/.test(entry))
    .sort();

  return [wrapperArchivePath, ...assetNames.map((entry) => join(distDir, entry))];
};

const githubReleaseExists = async (tag: string, repository: string): Promise<boolean> => {
  const proc = Bun.spawn(["gh", "release", "view", tag, "--repo", repository], {
    cwd: repoRoot,
    env: process.env,
    stdio: ["ignore", "ignore", "ignore"],
  });

  return (await proc.exited) === 0;
};

const syncGitHubRelease = async (input: {
  readonly tag: string;
  readonly channel: ReleaseChannel;
  readonly assetPaths: ReadonlyArray<string>;
}): Promise<void> => {
  if (!process.env.GH_TOKEN?.trim()) {
    throw new Error("GH_TOKEN is required to create or update a GitHub release.");
  }

  const repository = resolveGitHubRepository();

  if (await githubReleaseExists(input.tag, repository)) {
    await runCommand({
      command: "gh",
      args: [
        "release",
        "upload",
        input.tag,
        ...input.assetPaths,
        "--repo",
        repository,
        "--clobber",
      ],
      cwd: repoRoot,
    });
    return;
  }

  // Single rolling release-notes file. Historical release bodies live on
  // GitHub Releases — we don't archive per-version copies in the repo.
  const notesPath = resolve(cliRoot, "release-notes", "next.md");
  const notesFile = existsSync(notesPath) ? notesPath : null;

  // Draft until publish-desktop.yml finishes uploading installers and flips
  // it; otherwise /releases/latest/download/<desktop-asset> 404s during the
  // ~15-20 min desktop build window.
  const args = [
    "release",
    "create",
    input.tag,
    ...input.assetPaths,
    "--repo",
    repository,
    "--title",
    input.tag,
    ...(notesFile ? ["--notes-file", notesFile] : ["--generate-notes"]),
    "--verify-tag",
    "--draft",
  ];

  if (input.channel === "beta") {
    args.push("--prerelease");
  }

  await runCommand({
    command: "gh",
    args,
    cwd: repoRoot,
  });
};

const main = async () => {
  const options = parseArgs(process.argv.slice(2));
  const version = await readVersion();
  const tag = `v${version}`;
  const refTag = resolveTagFromEnvironment();
  const channel = resolveChannel(version);

  validateVersion(version);

  if (refTag && refTag !== tag) {
    throw new Error(`GitHub tag ${refTag} does not match ${versionPackagePath} version ${version}`);
  }

  await rm(releaseDir, { recursive: true, force: true });
  await mkdir(releaseDir, { recursive: true });

  await runCommand({
    command: "bun",
    args: ["run", "src/build.ts", "binary"],
    cwd: cliRoot,
  });

  await runCommand({
    command: "bun",
    args: ["run", "src/build.ts", "release-assets"],
    cwd: cliRoot,
  });

  const wrapperArchivePath = await packWrapperPackage();
  const assetPaths = await collectReleaseAssetPaths(wrapperArchivePath);

  console.log(`Prepared executor@${version} for ${channel}`);
  for (const assetPath of assetPaths) {
    console.log(`- ${assetPath}`);
  }

  if (options.dryRun) {
    return;
  }

  await syncGitHubRelease({
    tag,
    channel,
    assetPaths,
  });

  await runCommand({
    command: "bun",
    args: ["run", "src/build.ts", "publish", channel],
    cwd: cliRoot,
  });
};

await main();
