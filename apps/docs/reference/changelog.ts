import { code, groups, pageLink, table, wordCount, type Page } from "./markdown.ts";

export interface ReleaseNotes {
  readonly version: string;
  readonly announcement?: string;
  readonly notes: readonly { area: string; text: string }[];
}

export function changelogPages(version: string, releases: readonly ReleaseNotes[]): Page[] {
  const entries = releases.map(({ version, notes, announcement }) => ({
    version,
    body: [
      `## [${version}](https://github.com/UsefulSoftwareCo/executor/releases/tag/executor@${version})`,
      announcement !== undefined
        ? `Original release announcement. Commands and defaults reflect this release.\n\n${announcement}`
        : notes.length === 0
          ? "This release lists no specific changes."
          : table(
              ["Area", "Change"],
              notes.map(({ area, text }) => [area, text]),
            ),
    ].join("\n\n"),
  }));
  const parts = groups(entries, ({ body }) => wordCount(body), 1500);
  const pages = parts.map((part, index): Page => {
    const newest = part[0]!.version;
    const oldest = part.at(-1)!.version;
    return {
      route: index === 0 ? "/changelog" : `/changelog/through-${newest.replaceAll(".", "-")}`,
      title: index === 0 ? "Changelog" : `Changelog through ${newest}`,
      description: `Executor release notes from ${newest} through ${oldest}.`,
      body: [
        `This changelog covers Executor's CLI, desktop app and self-host image. Early entries include change notes from the release source. This page covers ${code(oldest)} through ${code(newest)}. The latest release covered by this reference is ${code(version)}.`,
        ...part.map(({ body }) => body),
      ].join("\n\n"),
    };
  });
  return pages.map((page, index) => {
    const links = pages
      .slice(Math.max(0, index - 1), index + 2)
      .filter((neighbor) => neighbor !== page);
    return {
      ...page,
      body: [page.body, links.map((neighbor) => `- ${pageLink(neighbor)}`).join("\n")]
        .filter(Boolean)
        .join("\n\n"),
    };
  });
}
