import { useCallback, useMemo } from "react";
import { createFileRoute, notFound, useNavigate } from "@tanstack/react-router";
import {
  PluginRouteProvider,
  useClientPlugins,
  type PageDecl,
  type PluginRouteValue,
} from "@executor-js/sdk/client";

// ---------------------------------------------------------------------------
// /plugins/<pluginId>/<rest>
//
// Mounts pages contributed by client plugins. The host's
// `<ExecutorPluginsProvider>` (set up at the root) materialises the
// list of `ClientPluginSpec` from `virtual:executor/plugins-client`,
// and this route reads it via `useClientPlugins()` — so adding a
// plugin to `executor.config.ts` is sufficient for its pages to mount
// here, with no per-route imports.
//
// Page match: exact path first, then longest path prefix, then the `/`
// root page. The splat remainder after the matched page path is exposed
// to the page via `<PluginRouteProvider>` (`usePluginRoute` /
// `usePluginNavigate`).
// ---------------------------------------------------------------------------

export const Route = createFileRoute("/{-$orgSlug}/plugins/$pluginId/$")({
  component: PluginRouteComponent,
});

function normalizePath(input: string): string {
  if (!input || input === "/") return "/";
  return input.startsWith("/") ? input : `/${input}`;
}

function stripLeadingSlash(path: string): string {
  return path.replace(/^\//, "");
}

function matchPluginPage(
  pages: readonly PageDecl[] | undefined,
  splat: string | undefined,
): { readonly page: PageDecl; readonly subpath: string } | null {
  const target = normalizePath(splat ?? "/");
  const normalized = (pages ?? []).map((page) => ({
    page,
    path: normalizePath(page.path),
  }));
  if (normalized.length === 0) return null;

  const exact = normalized.find((entry) => entry.path === target);
  if (exact) return { page: exact.page, subpath: "" };

  let best: (typeof normalized)[number] | null = null;
  for (const entry of normalized) {
    if (entry.path === "/") continue;
    if (target === entry.path || target.startsWith(`${entry.path}/`)) {
      if (!best || entry.path.length > best.path.length) best = entry;
    }
  }
  if (best) {
    const remainder = target.slice(best.path.length);
    return { page: best.page, subpath: stripLeadingSlash(remainder) };
  }

  const root = normalized.find((entry) => entry.path === "/");
  if (root) {
    return { page: root.page, subpath: target === "/" ? "" : stripLeadingSlash(target) };
  }
  return null;
}

function PluginRouteComponent() {
  const { pluginId, _splat: rest } = Route.useParams();
  const routerNavigate = useNavigate();
  const plugins = useClientPlugins();
  const plugin = plugins.find((p) => p.id === pluginId);
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: TanStack Router represents not-found from components by throwing notFound()
  if (!plugin) throw notFound();

  const matched = matchPluginPage(plugin.pages, rest);
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: TanStack Router represents not-found from components by throwing notFound()
  if (!matched) throw notFound();

  const { page, subpath } = matched;
  const pageSplat = stripLeadingSlash(normalizePath(page.path));

  const navigate = useCallback(
    (nextSubpath: string, opts?: { readonly replace?: boolean }) => {
      const fullSplat = nextSubpath
        ? pageSplat
          ? `${pageSplat}/${nextSubpath}`
          : nextSubpath
        : pageSplat;
      routerNavigate({
        to: "/{-$orgSlug}/plugins/$pluginId/$",
        params: (previous: Record<string, string>) => ({
          ...previous,
          pluginId,
          _splat: fullSplat,
        }),
        replace: opts?.replace,
      });
    },
    [routerNavigate, pluginId, pageSplat],
  );

  const routeValue = useMemo(
    (): PluginRouteValue => ({
      pluginId,
      subpath,
      navigate,
    }),
    [pluginId, subpath, navigate],
  );

  const Component = page.component;
  return (
    <PluginRouteProvider value={routeValue}>
      <Component />
    </PluginRouteProvider>
  );
}
