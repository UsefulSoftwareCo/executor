/**
 * The npm packages the e2e products install, pinned in `e2e/npm-packages.json`, so scenarios never
 * reach the public registry. The suite's loopback registry (e2e/support/npm-registry.ts) serves
 * only these versions, from archives this script downloads once and checks against their pinned
 * integrity.
 *
 *   node scripts/e2e-npm-packages.ts           Download missing archives into .local/test-runtime/npm.
 *   node scripts/e2e-npm-packages.ts --update  Resolve `roots` again and rewrite the lock.
 *
 * A scenario that declares a new package, or a change to the versions below, needs `--update`:
 * the download refuses a lock whose roots differ from these.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import apps from "../packages/apps/package.json" with { type: "json" };
import tailwind from "../packages/sdk/node_modules/tailwindcss/package.json" with { type: "json" };

type Root = { readonly name: string; readonly range: string; readonly transitive: boolean };
type Version = {
  readonly tarball: string;
  readonly integrity: string;
  readonly dependencies?: Readonly<Record<string, string>>;
};
type Lock = {
  readonly roots: ReadonlyArray<Root>;
  readonly packages: Record<
    string,
    { distTags: Record<string, string>; versions: Record<string, Version> }
  >;
};

const dependency = (name: string, range: string): Root => ({ name, range, transitive: true });
/** Installed alone, as the product installs `apps` releases and Tailwind's stylesheet. */
const alone = (name: string, range: string): Root => ({ name, range, transitive: false });

/** Every package a scenario's app declares and imports, and every `apps` release it pins. */
const roots: ReadonlyArray<Root> = [
  // Quick add, the authored MCP templates and MCP fixture apps.
  dependency("@modelcontextprotocol/sdk", apps.devDependencies["@modelcontextprotocol/sdk"]),
  // mcp-execute-failures.spec.ts pins an older SDK.
  dependency("@modelcontextprotocol/sdk", "1.30.0"),
  dependency("react", "19.2.0"),
  dependency("react", "^19.2.0"),
  dependency("react-dom", "19.2.0"),
  dependency("react-dom", "^19.2.0"),
  dependency("graphql", "16.11.0"),
  // Workflow fixture apps (support/workflow-app.ts).
  dependency("brotli-wasm", "3.0.1"),
  dependency("is-number", "7.0.0"),
  // cloud-compiler.spec.ts installs an exact zod release.
  dependency("zod", "3.25.76"),
  // The compiler installs Tailwind at the version the host bundles for `@import "tailwindcss"`.
  alone("tailwindcss", tailwind.version),
  ...[0, 1, 2, 4, 5, 9, 10, 14, 22, 33, 59, 84].map((beta) => alone("apps", `0.0.1-beta.${beta}`)),
];

const lockFile = path.resolve("e2e/npm-packages.json");
const archives = path.resolve(".local/test-runtime/npm");
const upstream = "https://registry.npmjs.org";
const timeout = 60_000;

/** The archive file for one locked version; the loopback registry reads the same name. */
const archiveName = (name: string, version: string) => `${name.replace("/", "+")}-${version}.tgz`;

const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};

const get = async (url: string, accept?: string) => {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(timeout),
    ...(accept === undefined ? {} : { headers: { Accept: accept } }),
  });
  if (!response.ok) fail(`${url} returned ${response.status}`);
  return response;
};

/**
 * Resolve every root as the compiler's installer does (`@cloudflare/worker-bundler`): an exact
 * version, a dist-tag, then the highest satisfying version, following `dependencies` of transitive
 * roots. Every range is resolved, not one version per name, so the lock holds the answer for any
 * install order. Serving only these versions leaves each range's answer unchanged.
 */
const update = async () => {
  // The installer's own semver, so ranges resolve exactly as they do in the product.
  const bundler = fs.realpathSync("packages/sdk/node_modules/@cloudflare/worker-bundler");
  const semver = createRequire(path.join(bundler, "package.json"))("semver") as {
    maxSatisfying: (versions: ReadonlyArray<string>, range: string) => string | null;
  };
  type Packument = {
    "dist-tags": Record<string, string>;
    versions: Record<
      string,
      {
        dependencies?: Record<string, string>;
        dist: { tarball: string; integrity: string };
      }
    >;
  };
  const packuments = new Map<string, Promise<Packument>>();
  const packument = (name: string) => {
    const known = packuments.get(name);
    if (known !== undefined) return known;
    const url = `${upstream}/${name.startsWith("@") ? `@${encodeURIComponent(name.slice(1))}` : name}`;
    const loaded = get(url, "application/json").then(
      (response) => response.json() as Promise<Packument>,
    );
    packuments.set(name, loaded);
    return loaded;
  };
  const resolve = (range: string, metadata: Packument) => {
    if (range === "latest" || range === "*") return metadata["dist-tags"].latest;
    if (metadata.versions[range]) return range;
    if (metadata["dist-tags"][range]) return metadata["dist-tags"][range];
    return semver.maxSatisfying(Object.keys(metadata.versions), range) ?? undefined;
  };
  const packages: Lock["packages"] = {};
  const visited = new Set<string>();
  const visit = async ({ name, range, transitive }: Root): Promise<void> => {
    const key = `${name}@${range}@${transitive}`;
    if (visited.has(key)) return;
    visited.add(key);
    const metadata = await packument(name);
    const version = resolve(range, metadata);
    const manifest = version === undefined ? undefined : metadata.versions[version];
    if (version === undefined || manifest === undefined)
      return fail(`${name}@${range} does not resolve on ${upstream}`);
    const entry = (packages[name] ??= { distTags: {}, versions: {} });
    entry.versions[version] = {
      tarball: manifest.dist.tarball,
      integrity: manifest.dist.integrity,
      ...(manifest.dependencies === undefined ? {} : { dependencies: manifest.dependencies }),
    };
    if (transitive)
      await Promise.all(
        Object.entries(manifest.dependencies ?? {}).map(([child, childRange]) =>
          visit(dependency(child, childRange)),
        ),
      );
  };
  await Promise.all(roots.map(visit));
  const sorted: Lock["packages"] = {};
  for (const name of Object.keys(packages).sort()) {
    const entry = packages[name]!;
    const tags = (await packument(name))["dist-tags"];
    sorted[name] = {
      // Only tags that name a locked version; a range never resolves to an unlocked one.
      distTags: Object.fromEntries(
        Object.entries(tags).filter(([, version]) => entry.versions[version] !== undefined),
      ),
      versions: Object.fromEntries(
        Object.keys(entry.versions)
          .sort()
          .map((version) => [version, entry.versions[version]!]),
      ),
    };
  }
  const lock: Lock = { roots, packages: sorted };
  fs.writeFileSync(lockFile, `${JSON.stringify(lock, null, 2)}\n`);
  const count = Object.values(sorted).reduce(
    (total, entry) => total + Object.keys(entry.versions).length,
    0,
  );
  console.log(`Locked ${count} package versions in ${path.relative(".", lockFile)}.`);
};

const integrityOf = (bytes: Uint8Array) =>
  `sha512-${createHash("sha512").update(bytes).digest("base64")}`;

/** Download each locked archive not already present, refusing bytes that miss its integrity. */
const download = async () => {
  const lock = JSON.parse(fs.readFileSync(lockFile, "utf8")) as Lock;
  if (JSON.stringify(lock.roots) !== JSON.stringify(roots))
    fail(
      `${path.relative(".", lockFile)} was resolved from other packages than scripts/e2e-npm-packages.ts names. Run: node scripts/e2e-npm-packages.ts --update`,
    );
  fs.mkdirSync(archives, { recursive: true });
  const wanted = Object.entries(lock.packages).flatMap(([name, entry]) =>
    Object.entries(entry.versions).map(([version, locked]) => ({
      file: path.join(archives, archiveName(name, version)),
      ...locked,
    })),
  );
  const keep = new Set(wanted.map(({ file }) => file));
  for (const name of fs.readdirSync(archives))
    if (!keep.has(path.join(archives, name))) fs.rmSync(path.join(archives, name));
  const missing = wanted.filter(
    ({ file, integrity }) =>
      !fs.existsSync(file) || integrityOf(fs.readFileSync(file)) !== integrity,
  );
  const queue = [...missing];
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
        const bytes = new Uint8Array(await (await get(next.tarball)).arrayBuffer());
        if (integrityOf(bytes) !== next.integrity)
          fail(`${next.tarball} does not match its locked integrity`);
        fs.writeFileSync(next.file, bytes);
      }
    }),
  );
  console.log(
    `npm archives: ${wanted.length - missing.length} present, ${missing.length} downloaded into ${path.relative(".", archives)}.`,
  );
};

await (process.argv.includes("--update") ? update() : download());
