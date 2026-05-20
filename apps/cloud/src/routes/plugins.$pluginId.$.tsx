import { createFileRoute, notFound } from "@tanstack/react-router";
import { useClientPlugins } from "@executor-js/sdk/client";

export const Route = createFileRoute("/plugins/$pluginId/$")({
  component: PluginRouteComponent,
});

function normalizePath(input: string): string {
  if (!input || input === "/") return "/";
  return input.startsWith("/") ? input : `/${input}`;
}

function PluginRouteComponent() {
  const { pluginId, _splat: rest } = Route.useParams();
  const plugins = useClientPlugins();
  const plugin = plugins.find((p) => p.id === pluginId);
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: TanStack Router represents not-found from components by throwing notFound()
  if (!plugin) throw notFound();

  const target = normalizePath(rest ?? "/");
  const page = plugin.pages?.find((p) => normalizePath(p.path) === target);
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: TanStack Router represents not-found from components by throwing notFound()
  if (!page) throw notFound();

  const Component = page.component;
  return <Component />;
}
