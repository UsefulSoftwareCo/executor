/**
 * Every dependency in a tracked package.json names one exact version, so bun.lock is the only place
 * a resolution can change and a dependency bump is a deliberate edit. A range lets `bun install`
 * or `bun add` move a package without anyone choosing the new version.
 *
 * Allowed: an exact semver 2.0.0 version, `npm:<name>@<exact version>` and `workspace:*`, in
 * dependencies, devDependencies, optionalDependencies, peerDependencies, overrides and resolutions.
 * A `patchedDependencies` selector names an exact version too. Anything else fails, including tags,
 * `file:`, `link:`, git and URL specifiers, other `workspace:` forms and nested overrides.
 *
 * Peer ranges are allowed only where they are the peer contract of a package we publish, listed in
 * `peerRanges`, and only as npm ranges of `^`, `~`, `>`, `>=`, `<` and `<=` comparators on full
 * versions, joined by spaces and `||`. An entry that is no longer such a range fails too, so the list
 * only shrinks.
 *
 * Before checking this repository it runs the same check on the fixtures in
 * check-exact-versions-fixtures.ts, manifests it must reject and ones it must accept.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fixtures } from "./check-exact-versions-fixtures.ts";

/** Published peer contracts: package.json path → dependency → why its range stays. */
type PeerRanges = Readonly<Record<string, Readonly<Record<string, string>>>>;

const peerRanges: PeerRanges = {
  // `apps` is published to npm by packages/apps/scripts/build.mjs, which copies these peers. Authors
  // bring their own copy; an exact peer would reject every other compatible release.
  "packages/apps/package.json": {
    "@modelcontextprotocol/sdk": "optional peer of `apps/mcp`",
    graphql: "optional peer of `apps/graphql`",
    react: "optional peer of `apps/react`",
  },
};

const dependencyFields = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
  "overrides",
  "resolutions",
] as const;

/**
 * A semver 2.0.0 version (semver.org): numbers without leading zeros, and dot-separated prerelease
 * and build identifiers that are not empty. A numeric prerelease identifier has no leading zero.
 */
const number = String.raw`(?:0|[1-9]\d*)`;
const prereleaseIdentifier = String.raw`(?:${number}|\d*[A-Za-z-][0-9A-Za-z-]*)`;
const version = String.raw`${number}\.${number}\.${number}(?:-${prereleaseIdentifier}(?:\.${prereleaseIdentifier})*)?`;
const build = String.raw`\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*`;
const exact = new RegExp(`^${version}(?:${build})?$`, "u");
const comparator = `(?:\\^|~|>=?|<=?)${version}`;
const comparators = `${comparator}(?: ${comparator})*`;
const range = new RegExp(`^${comparators}(?: \\|\\| ${comparators})*$`, "u");

const isExact = (spec: string) => {
  if (spec === "workspace:*") return true;
  const alias = /^npm:(?:@[^/@]+\/)?[^/@]+@(.+)$/u.exec(spec);
  return exact.test(alias ? alias[1]! : spec);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const own = (record: Readonly<Record<string, unknown>>, key: string) => Object.hasOwn(record, key);

/** What is wrong with these manifests, by path. */
const check = (
  manifests: ReadonlyArray<readonly [file: string, manifest: unknown]>,
  peers: PeerRanges,
): ReadonlyArray<string> => {
  const failures: Array<string> = [];
  const found = new Map(manifests);
  for (const [file, manifest] of manifests) {
    if (!isRecord(manifest)) {
      failures.push(`${file}: not a JSON object`);
      continue;
    }
    const allowed = own(peers, file) ? peers[file]! : {};
    for (const field of dependencyFields) {
      if (!own(manifest, field)) continue;
      const entries = manifest[field];
      if (!isRecord(entries)) {
        failures.push(`${file} ${field}: not an object`);
        continue;
      }
      for (const [name, spec] of Object.entries(entries)) {
        if (typeof spec !== "string") failures.push(`${file} ${field}.${name}: nested specifier`);
        else if (isExact(spec)) continue;
        else if (field === "peerDependencies" && own(allowed, name) && range.test(spec)) continue;
        else failures.push(`${file} ${field}.${name}: "${spec}"`);
      }
    }
    if (own(manifest, "patchedDependencies")) {
      const patched = manifest.patchedDependencies;
      if (!isRecord(patched)) failures.push(`${file} patchedDependencies: not an object`);
      else
        for (const selector of Object.keys(patched)) {
          const at = selector.lastIndexOf("@");
          if (at <= 0 || !exact.test(selector.slice(at + 1)))
            failures.push(
              `${file} patchedDependencies: "${selector}" is not <name>@<exact version>`,
            );
        }
    }
  }
  for (const [file, entries] of Object.entries(peers)) {
    const manifest = found.get(file);
    const declared =
      isRecord(manifest) && isRecord(manifest.peerDependencies) ? manifest.peerDependencies : {};
    for (const name of Object.keys(entries)) {
      const spec = own(declared, name) ? declared[name] : undefined;
      if (typeof spec !== "string" || !range.test(spec))
        failures.push(
          `${file} peerDependencies.${name}: no longer a range; remove it from peerRanges`,
        );
    }
  }
  return failures;
};

const wrong = fixtures.flatMap((fixture) => {
  const failures = check(Object.entries(fixture.manifests), fixture.peers ?? {});
  return fixture.accepted === (failures.length === 0)
    ? []
    : [
        `${fixture.name}: expected ${fixture.accepted ? "accepted" : "rejected"}, got ${failures.length === 0 ? "accepted" : failures.join("; ")}`,
      ];
});
if (wrong.length > 0) {
  console.error(
    "The version check is wrong about these fixtures (scripts/check-exact-versions-fixtures.ts):",
  );
  for (const problem of wrong) console.error(`  ${problem}`);
  process.exit(1);
}

const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
  encoding: "utf8",
})
  .split("\n")
  .filter((file) => file === "package.json" || file.endsWith("/package.json"));

const failures = check(
  files.map((file) => [file, JSON.parse(readFileSync(file, "utf8"))] as const),
  peerRanges,
);
if (failures.length) {
  console.error("Pin each dependency to the exact version in bun.lock:");
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}
const rejected = fixtures.filter((fixture) => !fixture.accepted).length;
console.log(
  `Exact versions in ${files.length} package.json files (the check rejects ${rejected} fixtures and accepts ${fixtures.length - rejected}).`,
);
