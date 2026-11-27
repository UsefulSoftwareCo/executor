import { posix } from "node:path";
import { code, groups, pageLink, partLinks, table, wordCount, type Page } from "./markdown.ts";

interface Section {
  readonly file: string;
  readonly content: string;
  readonly headings: readonly string[];
  readonly topic: string;
  readonly continued: boolean;
}

interface SkillPage extends Page {
  readonly sections: readonly Section[];
}

const root = "/reference/skills";
const startsFence = /^ {0,3}(`{3,}|~{3,})/u;
const heading = /^(#{1,6})\s+(.*)$/u;
const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_ -]/gu, "")
    .replaceAll(" ", "-");

function sections(file: string, markdown: string): Section[] {
  const result: Section[] = [];
  const body = markdown
    .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/u, "")
    .replace(/<!--[^]*?-->/gu, "");
  let fence: string | undefined;
  let lines: string[] = [];
  let headings: string[] = [];
  let blocks: string[] = [];
  let topic = "";
  const finishBlock = () => {
    const content = lines.join("\n").trimEnd();
    if (content) blocks.push(content);
    lines = [];
  };
  const flush = () => {
    finishBlock();
    if (blocks.length > 0) {
      const parts =
        wordCount(blocks.join("\n\n")) > 1740 ? groups(blocks, wordCount, 1680) : [blocks];
      for (const [index, part] of parts.entries()) {
        const content = part.join("\n\n").trim();
        const anchors = new Set(
          content.split("\n").flatMap((line) => {
            const title = heading.exec(line)?.[2];
            return title ? [slug(title)] : [];
          }),
        );
        result.push({
          file,
          content,
          headings: headings.filter((anchor) => anchors.has(anchor)),
          topic: heading.exec(content.split("\n", 1)[0]!)?.[2] ?? topic,
          continued: index > 0 && !heading.test(content.split("\n", 1)[0]!),
        });
      }
    }
    blocks = [];
    headings = [];
  };

  for (const line of body.split("\n")) {
    const marker = startsFence.exec(line)?.[1];
    if (fence !== undefined) {
      lines.push(line);
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
      continue;
    }
    if (marker) fence = marker;
    if (!marker && line === "" && !/^\s/u.test(lines[0] ?? "")) {
      finishBlock();
      continue;
    }
    const title = heading.exec(line);
    if (title?.[2] !== undefined) {
      if ((title[1]?.length ?? 0) <= 3) {
        flush();
        topic = title[2];
      }
      headings.push(slug(title[2]));
      lines.push(title[1] === "#" ? `## ${title[2]}` : line);
    } else {
      lines.push(line);
    }
  }
  flush();
  return result;
}

const skillGroups = [
  {
    slug: "executor",
    title: "Executor skill",
    files: ["executor/SKILL.md", "executor/feedback.md"],
  },
  { slug: "code-mode", title: "Code mode", files: ["code-mode/SKILL.md"] },
  {
    slug: "app-authoring",
    title: "App authoring",
    files: ["app-authoring/SKILL.md", "app-authoring/starter.md"],
  },
  { slug: "app-authoring/tools", title: "App tools", files: ["app-authoring/tools.md"] },
  { slug: "app-authoring/deploy", title: "App deployment", files: ["app-authoring/deploy.md"] },
  { slug: "app-authoring/ui", title: "App interfaces", files: ["app-authoring/ui.md"] },
  {
    slug: "app-authoring/accounts",
    title: "Provider accounts",
    files: ["app-authoring/accounts.md"],
  },
  {
    slug: "app-authoring/integrations",
    title: "Services and API imports",
    files: ["app-authoring/integrations.md"],
  },
  { slug: "app-authoring/storage", title: "App storage", files: ["app-authoring/storage.md"] },
  {
    slug: "app-authoring/background-work",
    title: "Workflows, webhooks and events",
    files: ["app-authoring/workflows.md", "app-authoring/webhooks.md", "app-authoring/events.md"],
  },
  {
    slug: "app-authoring/upgrades",
    title: "Historical app framework migrations",
    files: ["app-authoring/upgrades/0.0.1-beta.38.md", "app-authoring/upgrades/0.0.1-beta.90.md"],
  },
];

const migrations: Readonly<Record<string, string>> = {
  "app-authoring/upgrades/0.0.1-beta.38.md":
    "October 6, 2026. For apps on `0.0.1-beta.37` or earlier upgrading to `0.0.1-beta.38`, which replaced the document database with SQL.",
  "app-authoring/upgrades/0.0.1-beta.90.md":
    "October 13, 2026. For apps on `0.0.1-beta.89` or earlier upgrading to `0.0.1-beta.90`, which introduced scoped accounts.",
};
const currentUpgrade =
  "[Check the framework version on your host](/author-an-app) before upgrading.";

export function skillPages(
  version: string,
  framework: string,
  markdown: Readonly<Record<string, string>>,
): Page[] {
  const files = Object.keys(markdown);
  const selected = skillGroups.flatMap(({ files }) => files);
  if (files.toSorted().join("\n") !== selected.toSorted().join("\n"))
    throw new Error("Update the built-in skill page groups to cover the released source files");

  const pages = skillGroups.flatMap((group) => {
    const content = group.files.flatMap((file) => sections(file, markdown[file]!));
    const parts = groups(content, ({ content }) => wordCount(content), 1690).map(
      (sections, index) => {
        const first = sections[0]!;
        const topic = first.topic.replaceAll("`", "");
        const title =
          index === 0 || topic === ""
            ? group.title
            : `${group.title} · ${topic}${first.continued ? " (continued)" : ""}`;
        return {
          route: `${root}/${group.slug}${index === 0 ? "" : `-${index + 1}`}`,
          title,
          sections,
        };
      },
    );
    return parts.map(({ route, title, sections }, index): SkillPage => {
      const sourceFiles = [...new Set(sections.map(({ file }) => file))];
      const historical = migrations[sourceFiles[0]!] !== undefined;
      const first = sections[0]!;
      return {
        route,
        title,
        description: `${title} from the built-in skills in Executor ${version}.`,
        body: [
          historical
            ? `These historical migrations shipped with Executor ${code(version)}, which uses ` +
              `apps ${code(framework)}. Use the version named by your host for current apps. ${currentUpgrade}`
            : `This page covers ${first.topic || group.title} from the [built-in skills](${root}) shipped with Executor ${code(version)}. It contains ${sourceFiles.map(code).join(", ")}.`,
          partLinks(parts, index),
          first.continued ? `## ${first.topic}` : "",
        ]
          .filter(Boolean)
          .join("\n\n"),
        sections,
      };
    });
  });

  const locations = new Map<string, string>();
  for (const page of pages)
    for (const { file, headings } of page.sections) {
      if (!locations.has(file))
        locations.set(file, headings[0] ? `${page.route}#${headings[0]}` : page.route);
      for (const anchor of headings) locations.set(`${file}#${anchor}`, `${page.route}#${anchor}`);
    }

  const withLinks = ({ file, content }: Section) => {
    let fence: string | undefined;
    const documented =
      file === "app-authoring/SKILL.md"
        ? content
            .replace(
              /^\| Upgrade an app to a newer .*?\|.*?\|$/mu,
              `| Find the framework version to upgrade to | ${currentUpgrade} |`,
            )
            .replace(
              /Upgrade an app from before `apps@0\.0\.1-beta\.38`/u,
              "Historical migration from before `apps@0.0.1-beta.38`",
            )
            .replace(
              /^\| Find the framework version to upgrade to .*?\|$/mu,
              "$&\n| Historical migration from before `apps@0.0.1-beta.90` | [Account scope migration](upgrades/0.0.1-beta.90.md) |",
            )
        : content;
    const linked = documented
      .split("\n")
      .map((line) => {
        const marker = startsFence.exec(line)?.[1];
        if (marker) {
          if (fence === undefined) fence = marker;
          else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
          return line;
        }
        if (fence !== undefined) return line;
        return line.replace(
          /\]\(((?:[\w./-]+\.md)?(?:#[\w-]+)?)\)/gu,
          (match, destination: string) => {
            const [path, anchor] = destination.split("#");
            if (!path && !anchor) return match;
            const target = path ? posix.join(posix.dirname(file), path) : file;
            const route = locations.get(anchor ? `${target}#${anchor}` : target);
            if (route === undefined)
              throw new Error(`Unresolved skill link in ${file}: ${destination}`);
            return `](${route})`;
          },
        );
      })
      .join("\n");
    const migration = migrations[file];
    return migration && linked.startsWith("## Upgrade to ")
      ? linked.replace("\n", `\n\n${migration}\n`)
      : linked;
  };

  return [
    {
      route: root,
      title: "Built-in skills",
      description: `The Executor, code mode and app-authoring skills in Executor ${version}.`,
      body: [
        `This reference lists the built-in skills shipped with Executor ${code(version)}. Open a skill or topic below, or fetch the same guidance from Executor using the MCP [skills tool](/reference/mcp/skills).`,
        table(
          ["Topic", "Reference"],
          skillGroups.map((group) => [
            group.title,
            pages
              .filter(
                ({ route }) =>
                  route === `${root}/${group.slug}` ||
                  new RegExp(`^${root}/${group.slug}-[0-9]+$`, "u").test(route),
              )
              .map(pageLink)
              .join(", "),
          ]),
        ),
      ].join("\n\n"),
    },
    ...pages.map(({ sections, ...page }) => ({
      ...page,
      body: [page.body, ...sections.map(withLinks)].join("\n\n"),
    })),
  ];
}
