import { Effect } from "effect";
import { defaultMcpClientLimits } from "apps/contracts";
import type { StdioAppInput } from "../contracts/templates.ts";
import { packageFile, sourceFiles } from "./files.ts";

/** Generate a local MCP declaration; no process is started during generation. */
export const generateStdioApp = (input: StdioAppInput) =>
  Effect.gen(function* () {
    const serialize = (value: unknown) => JSON.stringify(value, null, 2);
    const environment = [...input.environment].sort();
    const config = {
      command: input.command,
      args: input.args,
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
      timeoutMs: input.timeoutMs ?? defaultMcpClientLimits.timeoutMs,
    };
    const fields = environment.map((name) => `[${serialize(name)}]: string()`).join(", ");
    const account = environment.length > 0;
    return {
      files: yield* sourceFiles([
        {
          path: "index.ts",
          content: `import { defineApp${account ? ", accountOperations" : ""} } from "apps";
import { stdioOperations } from "apps/mcp/stdio";
${account ? 'import { provider } from "./provider.ts"\n' : ""}
const process = ${serialize(config)};
export default defineApp({ accounts: ${account ? "{ service: provider.many() }" : "{}"} }, async ({ accounts, signal }) =>
  ${account ? "accountOperations(accounts.service, async (account) => " : ""}stdioOperations({ ...process, env: ${account ? "account.fields" : "{}"} }, signal)${account ? ", { signal })" : ""},
);
`,
        },
        packageFile(input.name, { "@modelcontextprotocol/sdk": "1.30.0" }),
        ...(account
          ? [
              {
                path: "provider.ts",
                content: `import { defineProvider, object, secrets, string } from "apps"\n\nexport const provider = defineProvider({\n  name: ${serialize(input.name)},\n  auth: { environment: secrets({ label: "Environment variables", fields: object({ ${fields} }) }) },\n})\n`,
              },
            ]
          : []),
      ]),
    };
  });
