import { createFileRoute, notFound } from "@tanstack/react-router";
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
// Match logic is intentionally tiny: exact path equality between the URL
// remainder and a `PageDecl.path`, with `""` and `/` treated as the
// same root. Plugins that want parameterized paths can build their own
// in-component routing for now.
// ---------------------------------------------------------------------------

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
