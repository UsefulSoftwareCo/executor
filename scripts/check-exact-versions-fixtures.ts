/**
 * Manifests check-exact-versions.ts must reject (`accepted: false`) or accept. `manifests` maps a
 * package.json path to its contents; `peers` is the fixture's published-peer allowlist, which
 * defaults to none.
 */
export type Fixture = {
  readonly name: string;
  readonly accepted: boolean;
  readonly manifests: Readonly<Record<string, unknown>>;
  readonly peers?: Readonly<Record<string, Readonly<Record<string, string>>>>;
};

const file = "packages/lib/package.json";
const peers = { [file]: { graphql: "published peer" } };

/** One manifest with `field` set to `entries`. */
const one = (field: string, entries: unknown) => ({ [file]: { [field]: entries } });

/** A published peer allowlisted for graphql, declared as `spec`. */
const peer = (name: string, accepted: boolean, spec: unknown): Fixture => ({
  name,
  accepted,
  manifests: one("peerDependencies", { graphql: spec }),
  peers,
});

/** `spec` as an ordinary dependency. */
const dependency = (name: string, accepted: boolean, spec: unknown): Fixture => ({
  name,
  accepted,
  manifests: one("dependencies", { pkg: spec }),
});

export const fixtures: ReadonlyArray<Fixture> = [
  dependency("exact version", true, "1.2.3"),
  dependency("exact prerelease", true, "2.0.0-beta.80"),
  dependency("exact with build metadata", true, "1.2.3+build.5"),
  dependency("npm alias to an exact version", true, "npm:typescript@5.9.3"),
  dependency("npm alias to a scoped exact version", true, "npm:@scope/pkg@1.0.0"),
  dependency("workspace:*", true, "workspace:*"),
  dependency("caret range", false, "^1.2.3"),
  dependency("tilde range", false, "~1.2.3"),
  dependency("comparator range", false, ">=1.2.3"),
  dependency("x-range", false, "1.x"),
  dependency("partial version", false, "1.2"),
  dependency("star", false, "*"),
  dependency("empty", false, ""),
  dependency("dist-tag", false, "latest"),
  dependency("workspace caret", false, "workspace:^"),
  dependency("workspace version", false, "workspace:1.0.0"),
  dependency("file path", false, "file:../pkg"),
  dependency("link", false, "link:../pkg"),
  dependency("git URL", false, "git+https://github.com/org/pkg.git#v1.2.3"),
  dependency("GitHub shorthand", false, "github:org/pkg"),
  dependency("tarball URL", false, "https://example.com/pkg-1.2.3.tgz"),
  dependency("npm alias to a range", false, "npm:typescript@^5.9.3"),
  dependency("npm alias to a tag", false, "npm:typescript@latest"),
  dependency("nested specifier", false, { version: "1.2.3" }),
  dependency("zero version", true, "0.0.0"),
  dependency("prerelease with hyphens", true, "1.0.0-x-y-z.--"),
  dependency("alphanumeric prerelease with leading zero", true, "1.0.0-0a.01b"),
  dependency("prerelease with build metadata", true, "1.0.0-rc.1+build.001"),
  dependency("leading zero in major", false, "01.2.3"),
  dependency("leading zero in minor", false, "1.02.3"),
  dependency("leading zero in patch", false, "1.2.03"),
  dependency("numeric prerelease with leading zero", false, "1.2.3-01"),
  dependency("empty prerelease", false, "1.2.3-"),
  dependency("empty prerelease identifier", false, "1.2.3-foo..bar"),
  dependency("prerelease ending in a dot", false, "1.2.3-foo."),
  dependency("empty build metadata", false, "1.2.3+"),
  dependency("empty build identifier", false, "1.2.3+build..5"),
  dependency("prerelease character outside semver", false, "1.2.3-beta_1"),
  dependency("two build sections", false, "1.2.3+a+b"),
  dependency("leading v", false, "v1.2.3"),
  dependency("npm alias with a leading zero", false, "npm:typescript@05.9.3"),
  {
    name: "devDependencies range",
    accepted: false,
    manifests: one("devDependencies", { pkg: "^1.2.3" }),
  },
  {
    name: "optionalDependencies range",
    accepted: false,
    manifests: one("optionalDependencies", { pkg: "~1.2.3" }),
  },
  {
    name: "peer range without an allowlist entry",
    accepted: false,
    manifests: one("peerDependencies", { pkg: "^1.2.3" }),
  },
  {
    name: "dependency field that is not an object",
    accepted: false,
    manifests: one("dependencies", "pkg@1.2.3"),
  },
  {
    name: "dependency field that is an array",
    accepted: false,
    manifests: one("dependencies", ["pkg@1.2.3"]),
  },
  { name: "manifest that is not an object", accepted: false, manifests: { [file]: [] } },
  { name: "exact override", accepted: true, manifests: one("overrides", { pkg: "1.2.3" }) },
  { name: "override range", accepted: false, manifests: one("overrides", { pkg: "^1.2.3" }) },
  {
    name: "nested override",
    accepted: false,
    manifests: one("overrides", { parent: { pkg: "1.2.3" } }),
  },
  {
    name: "exact resolution",
    accepted: true,
    manifests: one("resolutions", { "parent/pkg": "1.2.3" }),
  },
  { name: "resolution range", accepted: false, manifests: one("resolutions", { pkg: "^1.2.3" }) },
  { name: "resolution tag", accepted: false, manifests: one("resolutions", { pkg: "latest" }) },
  {
    name: "patched exact selector",
    accepted: true,
    manifests: one("patchedDependencies", { "@scope/pkg@1.0.0-rc.1": "patches/pkg.patch" }),
  },
  {
    name: "patched range selector",
    accepted: false,
    manifests: one("patchedDependencies", { "pkg@^1.0.0": "patches/pkg.patch" }),
  },
  {
    name: "patched selector without a version",
    accepted: false,
    manifests: one("patchedDependencies", { pkg: "patches/pkg.patch" }),
  },
  {
    name: "patched scoped selector without a version",
    accepted: false,
    manifests: one("patchedDependencies", { "@scope/pkg": "patches/pkg.patch" }),
  },
  {
    name: "patched selector with a leading zero",
    accepted: false,
    manifests: one("patchedDependencies", { "pkg@1.02.3": "patches/pkg.patch" }),
  },
  {
    name: "patched tag selector",
    accepted: false,
    manifests: one("patchedDependencies", { "pkg@latest": "patches/pkg.patch" }),
  },
  peer("published peer caret range", true, "^16.11.0"),
  peer("published peer tilde range", true, "~16.11.0"),
  peer("published peer bounded range", true, ">=16.11.0 <17.0.0"),
  peer("published peer union", true, "^16.11.0 || ^17.0.0-rc.1"),
  peer("published peer exact", false, "16.11.0"),
  peer("published peer workspace caret", false, "workspace:^"),
  peer("published peer workspace star", false, "workspace:*"),
  peer("published peer dist-tag", false, "latest"),
  peer("published peer file path", false, "file:../graphql"),
  peer("published peer git URL", false, "git+https://github.com/graphql/graphql-js.git"),
  peer("published peer GitHub shorthand", false, "github:graphql/graphql-js"),
  peer("published peer tarball URL", false, "https://example.com/graphql-16.11.0.tgz"),
  peer("published peer npm alias", false, "npm:graphql@^16.11.0"),
  peer("published peer star", false, "*"),
  peer("published peer x-range", false, "16.x"),
  peer("published peer partial version", false, "^16"),
  peer("published peer invalid version", false, "^not.a.version"),
  peer("published peer hyphen range", false, "16.0.0 - 17.0.0"),
  peer("published peer trailing junk", false, "^16.11.0 foo"),
  peer("published peer empty", false, ""),
  peer("published peer nested", false, { version: "^16.11.0" }),
  peer("published peer with a leading zero", false, "^016.11.0"),
  peer("published peer empty prerelease identifier", false, "^16.11.0-rc..1"),
  peer("published peer comparator with a leading zero", false, ">=16.011.0"),
  {
    name: "published peer missing",
    accepted: false,
    manifests: one("peerDependencies", {}),
    peers,
  },
  { name: "published peer manifest missing", accepted: false, manifests: {}, peers },
  {
    name: "peer named like an inherited property",
    accepted: false,
    manifests: one("peerDependencies", { graphql: "^16.11.0", toString: "latest" }),
    peers,
  },
  {
    name: "peer named __proto__",
    accepted: false,
    manifests: { [file]: JSON.parse('{"peerDependencies":{"__proto__":"latest"}}') },
    peers: { [file]: {} },
  },
  {
    name: "allowlisted name outside peerDependencies",
    accepted: false,
    manifests: {
      [file]: { peerDependencies: { graphql: "^16.11.0" }, dependencies: { graphql: "^16.11.0" } },
    },
    peers,
  },
  {
    name: "allowlist of another package",
    accepted: false,
    manifests: {
      [file]: { peerDependencies: { graphql: "^16.11.0" } },
      "packages/other/package.json": { peerDependencies: { graphql: "^16.11.0" } },
    },
    peers,
  },
];
