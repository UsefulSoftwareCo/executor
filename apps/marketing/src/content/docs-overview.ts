import { resolve, join } from "node:path";
import { createJiti } from "jiti";
import { buildDocsOverview, type DocsProject } from "../../../docs/overview.ts";
import { appHref, siteOrigin } from "./site-origin.ts";

export const docsOverview = async () => {
  const root = resolve("../docs");
  const jiti = createJiti(join(root, "blume.config.ts"));
  const { scanProject } = await jiti.import<{
    scanProject(root: string, options: { mode: "build" }): Promise<DocsProject>;
  }>("blume/core/project-graph.ts");
  return buildDocsOverview(await scanProject(root, { mode: "build" }));
};

export const desktopAppsPath = "/docs/desktop-apps";
export const docsIndexPath = "/docs/llms.txt";
export const overviewNote = "This overview is not exhaustive.";

export const setupLinksMarkdown = `## Get started

- [Sign in to Executor Cloud](${appHref("/login")}) to use a hosted Executor. [Create an account](${appHref("/login?mode=signup")}) if you're new to Cloud.
- [Run Executor locally](${siteOrigin}/docs/run/cli#install-and-start) from your terminal, or [download Executor Desktop](${siteOrigin}/#install).
- [Install apps as desktop apps](${siteOrigin}${desktopAppsPath}). An Executor app with a UI can open in its own window from Executor Desktop.`;

const escapeLinkLabel = (title: string) => title.replace(/[\\[\]`*_&<>~^]/g, "\\$&");

export const docsOverviewMarkdown = async () => {
  const sections = await docsOverview();
  return [
    "## What you can do with Executor",
    `${overviewNote} See the [full docs index](${siteOrigin}${docsIndexPath}).`,
    ...sections.map(({ title, pages }) =>
      [
        `### ${title}`,
        "",
        ...pages.map(
          ({ title, description, href }) =>
            `- [${escapeLinkLabel(title)}](${siteOrigin}${href})${description ? `: ${description}` : ""}`,
        ),
      ].join("\n"),
    ),
  ].join("\n\n");
};
