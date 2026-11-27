import { block, code, pageLink, table, type Page } from "./markdown.ts";

interface Tool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: object;
}

interface Profile {
  readonly protocol: string;
  readonly capabilities: Readonly<Record<string, unknown>>;
  readonly tools: readonly Tool[];
}

export interface Mode {
  readonly mode: string;
  readonly profiles: readonly Profile[];
}

export function mcpPages(version: string, modes: readonly Mode[]): Page[] {
  const profiles = modes.flatMap(({ mode, profiles }) =>
    profiles.map((profile) => ({ ...profile, mode })),
  );
  const names = [...new Set(profiles.flatMap(({ tools }) => tools.map(({ name }) => name)))].sort();
  const toolPages = names.map((name): Page => {
    const definitions = new Map<string, { tool: Tool; modes: Map<string, string[]> }>();
    for (const { mode, protocol, tools } of profiles) {
      const tool = tools.find((tool) => tool.name === name);
      if (tool === undefined) continue;
      const key = JSON.stringify([tool.description, tool.inputSchema]);
      let definition = definitions.get(key);
      if (definition === undefined) {
        definition = { tool, modes: new Map() };
        definitions.set(key, definition);
      }
      const protocols = definition.modes.get(mode) ?? [];
      protocols.push(protocol);
      definition.modes.set(mode, protocols);
    }
    return {
      route: `/reference/mcp/${name}`,
      title: `MCP ${name}`,
      description: `Input schema and availability for the ${name} tool in Executor ${version}.`,
      body: [
        `This page lists the input schemas returned by \`tools/list\` for ${code(name)} in Executor ${code(version)}. The table above each schema identifies which elicitation modes and protocol versions return it.`,
        ...[...definitions.values()].map(({ tool, modes }, index) =>
          [
            `## ${definitions.size === 1 ? "Input schema" : `Input schema ${index + 1}`}`,
            tool.description.replaceAll("<", "\\<"),
            table(
              ["Elicitation mode", "MCP protocol versions"],
              [...modes].map(([mode, protocols]) => [code(mode), protocols.map(code).join(", ")]),
            ),
            block("json", JSON.stringify(tool.inputSchema, null, 2)),
          ].join("\n\n"),
        ),
      ].join("\n\n"),
    };
  });
  const capabilities = new Map<
    string,
    { capabilities: Profile["capabilities"]; uses: Map<string, string[]> }
  >();
  for (const { mode, protocol, capabilities: values } of profiles) {
    const key = JSON.stringify(values);
    let group = capabilities.get(key);
    if (!group) {
      group = { capabilities: values, uses: new Map() };
      capabilities.set(key, group);
    }
    const protocols = group.uses.get(mode) ?? [];
    protocols.push(protocol);
    group.uses.set(mode, protocols);
  }
  return [
    {
      route: "/reference/mcp",
      title: "MCP reference",
      description: `MCP tools, input schemas and server capabilities in Executor ${version}.`,
      body: [
        `This reference lists the tools and server capabilities advertised by Executor ${code(version)} on \`/mcp\`. Capabilities come from \`initialize\` or \`server/discover\`; each tool page shows its wire input schema from \`tools/list\`. See [The MCP endpoint](/mcp) for connection and approval options.`,
        "## Tools",
        table(
          ["Tool", "Elicitation modes", "Input schemas"],
          names.map((name, index) => [
            code(name),
            modes
              .filter(({ profiles }) =>
                profiles.some(({ tools }) => tools.some((tool) => tool.name === name)),
              )
              .map(({ mode }) => code(mode))
              .join(", "),
            pageLink(toolPages[index]!),
          ]),
        ),
        "## Server capabilities",
        ...[...capabilities.values()].map(({ capabilities, uses }) =>
          [
            table(
              ["Elicitation mode", "MCP protocol versions"],
              [...uses].map(([mode, protocols]) => [code(mode), protocols.map(code).join(", ")]),
            ),
            table(
              ["Capability", "Advertised value"],
              Object.entries(capabilities).map(([name, value]) => [
                code(name),
                code(JSON.stringify(value)),
              ]),
            ),
          ].join("\n\n"),
        ),
      ].join("\n\n"),
    },
    ...toolPages,
  ];
}
