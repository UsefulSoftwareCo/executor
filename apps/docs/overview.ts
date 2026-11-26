import type { NavNode, Navigation, PageRecord, ResolvedConfig } from "blume";
import { normalizeBasePath, withBasePath } from "blume/core/base-path.ts";

export interface DocsProject {
  config: Pick<ResolvedConfig, "deployment">;
  graph: { pages: readonly PageRecord[]; navigation: Navigation };
}

export const buildDocsOverview = ({ config, graph }: DocsProject) => {
  const base = normalizeBasePath(config.deployment.base);
  const pages = new Map(
    graph.pages
      .filter(({ meta }) => !meta.draft && !meta.sidebar.hidden && !meta.seo.noindex)
      .map(({ title, description, route }) => [
        route,
        { title, description, href: withBasePath(base, route) },
      ]),
  );
  const takePage = (route: string) => {
    const page = pages.get(route);
    if (page === undefined) return [];
    pages.delete(route);
    return [page];
  };
  const takePages = (node: NavNode): ReturnType<typeof takePage> => [
    ...(node.route === undefined ? [] : takePage(node.route)),
    ...(node.kind === "group" ? node.children.flatMap(takePages) : []),
  ];

  const sections = graph.navigation.sidebar.map((node) => ({
    title: node.kind === "group" ? node.label : "Documentation",
    pages: takePages(node),
  }));
  if (pages.size > 0) sections.push({ title: "More documentation", pages: [...pages.values()] });
  return sections.filter(({ pages }) => pages.length > 0);
};
