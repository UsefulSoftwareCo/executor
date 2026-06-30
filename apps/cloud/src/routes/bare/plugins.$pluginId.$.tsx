import { createFileRoute, notFound } from "@tanstack/react-router";
import { useClientPlugins } from "@executor-js/sdk/client";

// Bare (unauthenticated) cloud mount for client-plugin pages. The shared
// console route at `/{-$orgSlug}/plugins/$pluginId/$` is intentionally excluded
// on cloud (it lives inside the WorkOS auth shell); the generated UI fallback
// (`/plugins/dynamic-ui/render`) is reached without a session, so it needs a
// route outside the org scope. Page matching mirrors the shared console route.
export const Route = createFileRoute("/plugins/$pluginId/$")({
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

const matchPluginPagePath = (
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

function PluginRouteComponent() {
  const { pluginId, _splat: rest } = Route.useParams();
  const plugins = useClientPlugins();
  const plugin = plugins.find((p) => p.id === pluginId);
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: TanStack Router represents not-found from components by throwing notFound()
  if (!plugin) throw notFound();

  const target = normalizePath(rest ?? "/");
  const match =
    (plugin.pages ?? [])
      .map((page, index) => ({ page, index, params: matchPluginPagePath(page.path, target) }))
      .filter(
        (
          candidate,
        ): candidate is {
          page: (typeof candidate)["page"];
          index: number;
          params: Readonly<Record<string, string>>;
        } => candidate.params !== null,
      )
      .sort((a, b) => matchScore(b.page.path) - matchScore(a.page.path) || a.index - b.index)[0] ??
    null;
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: TanStack Router represents not-found from components by throwing notFound()
  if (!match) throw notFound();

  const Component = match.page.component;
  return <Component params={match.params} path={target} pluginId={pluginId} />;
}
