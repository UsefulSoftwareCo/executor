import { PROVIDED_SCOPE_NAMES } from "../src/shell/component-runtime";
const header = `/**
 * Every name model-generated \`create-artifact\` code may reference without declaring
 * it — React hooks, TanStack Query, the \`tools\` proxy, and every shadcn,
 * Recharts and Lucide export the shell binds into scope.
 *
 * GENERATED from the shell's real evaluation scope
 * (\`@executor-js/mcp-apps-shell\` \`PROVIDED_SCOPE_NAMES\`). Do not hand-edit:
 * \`provided-globals.pin.test.ts\` in the shell package fails if this drifts from
 * what the iframe actually binds. Regenerate by running that package's
 * \`bun run gen:provided-globals\`.
 *
 * It lives here rather than in the shell package because the MCP host must
 * validate generated code without importing React.
 */

export const PROVIDED_GLOBAL_NAMES: ReadonlySet<string> = new Set([
`;
const body = PROVIDED_SCOPE_NAMES.map((n) => `  ${JSON.stringify(n)},`).join("\n");
await Bun.write(
  new URL("../../../core/execution/src/provided-globals.ts", import.meta.url).pathname,
  `${header}${body}\n]);\n`,
);
