import type { McpInstallFormat } from "../../contracts/mcp.ts";

const shellQuote = (value: string): string => `'${value.replace(/'/g, `'"'"'`)}'`;

/** Build client instructions; browser OAuth connections omit the bearer header. */
export function mcpInstallCode(
  format: McpInstallFormat,
  endpoint: string,
  apiKey?: string,
): string {
  const headers = apiKey === undefined ? undefined : { Authorization: `Bearer ${apiKey}` };
  const headerFlag =
    headers === undefined
      ? ""
      : ` \\\n  --header ${shellQuote(`Authorization: ${headers.Authorization}`)}`;
  switch (format) {
    case "installer":
      return `npx add-mcp ${shellQuote(endpoint)} --transport http --name executor${headerFlag}`;
    case "claude":
      return `claude mcp add --transport http --scope user executor ${shellQuote(endpoint)}${headerFlag}`;
    case "json":
      return JSON.stringify(
        { mcpServers: { executor: { type: "http", url: endpoint, headers } } },
        null,
        2,
      );
  }
}
