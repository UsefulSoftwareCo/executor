import {
  block,
  code,
  groups,
  pageLink,
  partLinks,
  table,
  wordCount,
  type Page,
} from "./markdown.ts";

interface Command {
  readonly path: readonly string[];
  readonly help: ReadonlyMap<string, string>;
}

const rows = (section: string | undefined) =>
  section?.split("\n").map((line) => {
    const match = /^(.*?) {2,}(.*)$/u.exec(line);
    return match ? ([match[1]!, match[2]!] as const) : ([line, ""] as const);
  }) ?? [];

const flags = (section: string | undefined) =>
  table(
    ["Option", "Description"],
    rows(section).map(([name, description]) => [code(name), description]),
  );

export function commands(
  helpOutput: (path: readonly string[]) => string,
  path: readonly string[] = [],
): Command[] {
  const help = new Map(
    [
      ...helpOutput(path)
        .trimEnd()
        .matchAll(/^([A-Z ]+)\n((?: {2}.*\n|\n)* {2}.*$)/gmu),
    ].map(([, name, content]) => [name!, content!.replace(/^ {2}/gmu, "").trimEnd()]),
  );
  if (!help.has("USAGE")) throw new Error(`Cannot read help for executor ${path.join(" ")}`);
  return [
    { path, help },
    ...rows(help.get("SUBCOMMANDS")).flatMap(([child]) => commands(helpOutput, [...path, child])),
  ];
}

const commandSection = ({ path, help }: Command) =>
  [
    `## ${code(["executor", ...path].join(" "))}`,
    help.get("DESCRIPTION"),
    block("text", help.get("USAGE")!),
    help.has("ARGUMENTS") ? flags(help.get("ARGUMENTS")) : undefined,
    help.has("FLAGS") ? flags(help.get("FLAGS")) : undefined,
    help.has("EXAMPLES") ? block("sh", help.get("EXAMPLES")!) : undefined,
  ]
    .filter(Boolean)
    .join("\n\n");

export function cliPages(version: string, helpOutput: (path: readonly string[]) => string): Page[] {
  const [root, ...children] = commands(helpOutput);
  if (root === undefined || children.length === 0) throw new Error("Executor help has no commands");
  const pages = [
    {
      label: "Tools and sign-in",
      slug: "tools",
      include: ({ path }: Command) => !["apps", "service", "serve", "upgrade"].includes(path[0]!),
    },
    { label: "App commands", slug: "apps", include: ({ path }: Command) => path[0] === "apps" },
    {
      label: "Local service and upgrades",
      slug: "service",
      include: ({ path }: Command) => ["service", "serve", "upgrade"].includes(path[0]!),
    },
  ].flatMap(({ label, slug, include }) => {
    const selected = children.filter(include).map((command) => ({
      name: ["executor", ...command.path].join(" "),
      body: commandSection(command),
    }));
    const parts = groups(selected, ({ body }) => wordCount(body), 1550).map((part, index) => ({
      route: `/reference/cli/${slug}${index === 0 ? "" : `-${index + 1}`}`,
      title: index === 0 ? label : `${label} starting at ${part[0]!.name}`,
      part,
    }));
    return parts.map(({ route, title, part }, index): Page => ({
      route,
      title,
      description: `Executor CLI ${version} usage, arguments, flags and examples for ${label.toLowerCase()}.`,
      body: [
        `These commands come from Executor CLI ${code(version)} and cover ${code(part[0]!.name)} through ${code(part.at(-1)!.name)}. See [global flags and command groups](/reference/cli#global-flags).`,
        partLinks(parts, index),
        ...part.map(({ body }) => body),
      ]
        .filter(Boolean)
        .join("\n\n"),
    }));
  });

  return [
    {
      route: "/reference/cli",
      title: "CLI reference",
      description: `Commands, flags and examples for Executor CLI ${version}.`,
      body: [
        `This reference lists the commands, arguments, flags and examples shown by \`executor --help\` and its subcommands in Executor CLI ${code(version)}. Open a command group for its full usage and examples.`,
        table(
          ["Command group", "Reference"],
          [
            [
              "Sign in, search, call tools, read skills and serve MCP",
              pageLink(pages[0]!) +
                pages
                  .filter((page) => page.route.startsWith("/reference/cli/tools-"))
                  .map((page) => `, ${pageLink(page)}`)
                  .join(""),
            ],
            [
              "Create, build, deploy and publish apps",
              pages
                .filter((page) => page.route.startsWith("/reference/cli/apps"))
                .map(pageLink)
                .join(", "),
            ],
            [
              "Manage the local server and install upgrades",
              pages
                .filter((page) => page.route.startsWith("/reference/cli/service"))
                .map(pageLink)
                .join(", "),
            ],
          ],
        ),
        commandSection(root),
        "## Global flags",
        flags(root.help.get("GLOBAL FLAGS")),
      ].join("\n\n"),
    },
    ...pages,
  ];
}
