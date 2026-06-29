import { createFileRoute, Navigate, notFound } from "@tanstack/react-router";
import { useClientPlugins } from "@executor-js/sdk/client";

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
// Plugin pages use the same lightweight route vocabulary as the rest of the
// console route tree: static segments and `$param` segments. The host route
// owns that matching so plugin detail views can be real URLs instead of
// in-component state.
// ---------------------------------------------------------------------------

export const Route = createFileRoute("/{-$orgSlug}/plugins/$pluginId/$")({
  component: PluginRouteComponent,
});

function normalizePath(input: string): string {
  if (!input || input === "/") return "/";
  const withLeadingSlash = input.startsWith("/") ? input : `/${input}`;
  return withLeadingSlash.length > 1 ? withLeadingSlash.replace(/\/+$/, "") : "/";
}

const pathSegments = (input: string): readonly string[] =>
  normalizePath(input)
    .split("/")
    .filter((segment) => segment.length > 0);

export const matchPluginPagePath = (
  pattern: string,
  target: string,
): Readonly<Record<string, string>> | null => {
  const patternSegments = pathSegments(pattern);
  const targetSegments = pathSegments(target);
  if (patternSegments.length !== targetSegments.length) return null;

  const params: Record<string, string> = {};
  for (let index = 0; index < patternSegments.length; index += 1) {
    const patternSegment = patternSegments[index]!;
    const targetSegment = targetSegments[index]!;
    if (patternSegment.startsWith("$") && patternSegment.length > 1) {
      params[patternSegment.slice(1)] = decodeURIComponent(targetSegment);
      continue;
    }
    if (patternSegment !== targetSegment) return null;
  }
  return params;
};

const matchScore = (pattern: string): number =>
  pathSegments(pattern).reduce((score, segment) => score + (segment.startsWith("$") ? 1 : 2), 0);

export const matchPluginPage = <TPage extends { readonly path: string }>(
  pages: readonly TPage[] | undefined,
  target: string,
): { readonly page: TPage; readonly params: Readonly<Record<string, string>> } | null => {
  const matches =
    pages
      ?.map((page, index) => ({
        page,
        index,
        params: matchPluginPagePath(page.path, target),
        score: matchScore(page.path),
      }))
      .filter(
        (
          candidate,
        ): candidate is {
          readonly page: TPage;
          readonly index: number;
          readonly params: Readonly<Record<string, string>>;
          readonly score: number;
        } => candidate.params !== null,
      )
      .sort((a, b) => b.score - a.score || a.index - b.index) ?? [];
  const first = matches[0];
  return first ? { page: first.page, params: first.params } : null;
};

function PluginRouteComponent() {
  const { orgSlug, pluginId, _splat: rest } = Route.useParams();
  const plugins = useClientPlugins();
  const target = normalizePath(rest ?? "/");
  if (pluginId === "toolkits") {
    const segments = pathSegments(target);
    const toolkitSlug = segments[0];
    if (toolkitSlug) {
      return (
        <Navigate
          to="/{-$orgSlug}/toolkits/$toolkitSlug"
          params={{ orgSlug, toolkitSlug }}
          replace
        />
      );
    }
    return <Navigate to="/{-$orgSlug}/toolkits" params={{ orgSlug }} replace />;
  }

  const plugin = plugins.find((p) => p.id === pluginId);
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: TanStack Router represents not-found from components by throwing notFound()
  if (!plugin) throw notFound();

  const match = matchPluginPage(plugin.pages, target);
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: TanStack Router represents not-found from components by throwing notFound()
  if (!match) throw notFound();

  const Component = match.page.component;
  return <Component params={match.params} path={target} pluginId={pluginId} />;
}
