/**
 * Creates or updates `.reference/effect-v4/` at the Effect release tag for the npm version pinned
 * in the root package.json. See notes/coding-style.md.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const dir = join(root, ".reference", "effect-v4");
const remote = "https://github.com/Effect-TS/effect.git";
const exact = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};

const git = (...args: string[]) =>
  execFileSync("git", ["-C", dir, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();

const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const versions = new Map<string, string[]>();
for (const field of ["dependencies", "devDependencies", "overrides"]) {
  for (const [name, spec] of Object.entries<string>(manifest[field] ?? {})) {
    if (name !== "effect" && !name.startsWith("@effect/")) continue;
    // @effect/tsgo is the language-service compiler, versioned separately from Effect.
    if (name === "@effect/tsgo") continue;
    if (!exact.test(spec)) fail(`${field}.${name} is not an exact npm version: ${spec}`);
    versions.set(spec, [...(versions.get(spec) ?? []), `${field}.${name}`]);
  }
}
if (versions.size !== 1) {
  fail(
    versions.size === 0
      ? "No effect or @effect/* versions found in package.json."
      : `Effect versions disagree:\n${[...versions].map(([version, names]) => `  ${version}: ${names.join(", ")}`).join("\n")}`,
  );
}
const [version] = versions.keys();
const tag = `effect@${version}`;
const refs = new Map(
  execFileSync("git", ["ls-remote", remote, `refs/tags/${tag}`, `refs/tags/${tag}^{}`], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  })
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha, ref] = line.split("\t");
      return [ref, sha] as const;
    }),
);
// An annotated tag names a tag object; its `^{}` entry is the tagged commit.
const commit =
  refs.get(`refs/tags/${tag}^{}`) ??
  refs.get(`refs/tags/${tag}`) ??
  fail(`${remote} has no tag ${tag}.`);

if (!existsSync(join(dir, ".git"))) {
  if (existsSync(dir) && readdirSync(dir).length) fail(`${dir} exists but is not a git checkout.`);
  mkdirSync(dir, { recursive: true });
  git("init", "--quiet");
} else {
  const changes = git("status", "--porcelain");
  if (changes) fail(`${dir} has local changes; leaving it untouched:\n${changes}`);
  // An interrupted first run can leave a repository without a HEAD commit.
  const head = spawnSync("git", ["-C", dir, "rev-parse", "--verify", "--quiet", "HEAD"], {
    encoding: "utf8",
  }).stdout.trim();
  if (head === commit) {
    console.log(`.reference/effect-v4 is already at ${tag} (${commit}).`);
    process.exit(0);
  }
}

git("fetch", "--quiet", "--depth", "1", remote, commit);
git("checkout", "--quiet", "--detach", "FETCH_HEAD");
console.log(`.reference/effect-v4 is at ${tag} (${git("rev-parse", "HEAD")}).`);
