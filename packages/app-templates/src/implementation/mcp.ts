import { Effect } from "effect";
import { packageFile, sourceFiles } from "./files.ts";

/**
 * A remote MCP app whose connection was confirmed: public, or OAuth discovered from the server.
 * All runtime behavior is retained in editable files and public app-framework helpers.
 */
export const generateMcpSource = (
  name: string,
  url: string,
  oauth?: { readonly discover: string },
) =>
  Effect.gen(function* () {
    const serialize = (value: unknown) => JSON.stringify(value, null, 2);
    const index = oauth
      ? `import { defineApp, accountOperations } from "apps"
import { mcpOperations } from "apps/mcp"
import { provider } from "./provider.ts"

export default defineApp({ accounts: { service: provider.many() } }, async ({ accounts, signal, cache }) =>
  accountOperations(accounts.service, async (account) => mcpOperations({
    url: ${serialize(url)},
    cache: cache.forAccount(account),
    accountId: account.id,
    headers: { Authorization: "Bearer " + account.fields.access_token },
    signal,
  }), { signal }),
)
`
      : `import { defineApp } from "apps"
import { mcpOperations } from "apps/mcp"

export default defineApp({ accounts: {} }, async ({ accounts, signal, cache }) =>
  mcpOperations({
    url: ${serialize(url)},
    cache,
    signal,
  }),
)
`;
    return {
      files: yield* sourceFiles([
        { path: "index.ts", content: index },
        ...(oauth
          ? [
              {
                path: "provider.ts",
                content: `import { defineProvider, oauth2 } from "apps"

export const provider = defineProvider({
  name: ${serialize(name)},
  auth: {
    oauth: oauth2(${serialize(oauth)})
  },
})
`,
              },
            ]
          : []),
        packageFile(name, { "@modelcontextprotocol/sdk": "1.30.0" }),
      ]),
    };
  });
