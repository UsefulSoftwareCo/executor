import { index, route } from "@tanstack/virtual-file-routes";
import type { VirtualRouteNode } from "@tanstack/virtual-file-routes";

// ---------------------------------------------------------------------------
// The shared console route contract. This package's pages and shell link to
// these paths (`Link to="/{-$orgSlug}/integrations/$namespace"` etc.), so every
// app that renders the shared console MUST register them — historically each
// app re-declared the same route files by hand and they drifted
// (host-cloudflare shipped `/sources/*` while the shell linked
// `/integrations/*`).
//
// `consoleRoutes()` makes the contract executable: app vite configs compose it
// into their TanStack `virtualRouteConfig`, mounting the canonical route files
// that live in `src/routes/` next to the pages they bind. Apps keep their own
// `__root.tsx` (the auth shell is what genuinely differs) and add app-specific
// routes alongside. An app with an intentionally different surface for one of
// these paths excludes it here and registers its own file instead.
//
// Every console route lives under an OPTIONAL `{-$orgSlug}` segment: the same
// route matches both `/policies` and `/acme/policies`. Org-scoped hosts
// (cloud, self-host, cloudflare) canonicalize bare URLs to the active
// organization's slug at their auth gate; local/desktop never set the param
// and stay bare. Because the shared files are mounted by every app AND by this
// package's own codegen, the prefix must be identical everywhere — the
// generator rewrites `createFileRoute()` ids on disk to match the mounted
// path, so divergent mounts would make builds fight over the files.
// ---------------------------------------------------------------------------

/** The optional org-slug path segment every console route nests under. */
export const ORG_SLUG_SEGMENT = "{-$orgSlug}";

/** Console paths relative to the org scope ("/" is the integrations index).
 *  These are the exclude keys for {@link consoleRoutes} — the actual route ids
 *  are these paths prefixed with `/{-$orgSlug}`. */
export const CONSOLE_ROUTE_PATHS = [
  "/",
  "/integrations/$namespace",
  "/integrations/add/$pluginKey",
  "/policies",
  "/secrets",
  "/tools",
  "/toolkits",
  "/toolkits/$toolkitSlug",
  "/resume/$executionId",
  "/plugins/$pluginId/$",
] as const;

export type ConsoleRoutePath = (typeof CONSOLE_ROUTE_PATHS)[number];

export interface ConsoleRoutesOptions {
  /** Path from the app's `routesDirectory` to this package's `src/routes`. */
  readonly dir: string;
  /** Shared paths this app replaces with its own route file (or omits). */
  readonly exclude?: ReadonlyArray<ConsoleRoutePath>;
  /** App-specific routes mounted INSIDE the org scope (e.g. cloud's /billing).
   *  Paths are relative to the scope, same as {@link CONSOLE_ROUTE_PATHS}. */
  readonly orgScoped?: ReadonlyArray<VirtualRouteNode>;
}

export const consoleRoutes = (options: ConsoleRoutesOptions): Array<VirtualRouteNode> => {
  const excluded = new Set(options.exclude ?? []);
  const file = (name: string): string => `${options.dir}/${name}`;
  const entries: ReadonlyArray<readonly [ConsoleRoutePath, VirtualRouteNode]> = [
    ["/", index(file("index.tsx"))],
    [
      "/integrations/$namespace",
      route("/integrations/$namespace", file("integrations.$namespace.tsx")),
    ],
    [
      "/integrations/add/$pluginKey",
      route("/integrations/add/$pluginKey", file("integrations.add.$pluginKey.tsx")),
    ],
    ["/policies", route("/policies", file("policies.tsx"))],
    ["/secrets", route("/secrets", file("secrets.tsx"))],
    ["/tools", route("/tools", file("tools.tsx"))],
    ["/toolkits", route("/toolkits", file("toolkits.tsx"))],
    ["/toolkits/$toolkitSlug", route("/toolkits/$toolkitSlug", file("toolkits.$toolkitSlug.tsx"))],
    ["/resume/$executionId", route("/resume/$executionId", file("resume.$executionId.tsx"))],
    ["/plugins/$pluginId/$", route("/plugins/$pluginId/$", file("plugins.$pluginId.$.tsx"))],
  ];
  const shared = entries.filter(([path]) => !excluded.has(path)).map(([, node]) => node);
  return [route(`/${ORG_SLUG_SEGMENT}`, [...shared, ...(options.orgScoped ?? [])])];
};
