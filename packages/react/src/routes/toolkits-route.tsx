import { notFound } from "@tanstack/react-router";
import { useClientPlugins } from "@executor-js/sdk/client";

export function ToolkitsPluginRoute(props: { toolkitSlug?: string }) {
  const plugins = useClientPlugins();
  const plugin = plugins.find((candidate) => candidate.id === "toolkits");
  const path = props.toolkitSlug ? `/${props.toolkitSlug}` : "/";
  const page = plugin?.pages?.find((candidate) =>
    props.toolkitSlug ? candidate.path === "/$toolkitSlug" : candidate.path === "/",
  );

  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: TanStack Router represents not-found from components by throwing notFound()
  if (!plugin || !page) throw notFound();

  const Component = page.component;
  return (
    <Component
      params={props.toolkitSlug ? { toolkitSlug: props.toolkitSlug } : {}}
      path={path}
      pluginId={plugin.id}
    />
  );
}
