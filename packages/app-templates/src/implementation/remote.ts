import { Effect } from "effect";
import type { RemoteAuth } from "../contracts/templates.ts";
import { packageFile, sourceFiles } from "./files.ts";

/** All runtime behavior is retained in editable files and public app-framework helpers. */
export const generateRemoteApp = (
  name: string,
  url: string,
  kind: "mcp" | "graphql",
  auth: RemoteAuth,
) =>
  Effect.gen(function* () {
    const serialize = (value: unknown) => JSON.stringify(value, null, 2);
    const helper = kind === "mcp" ? "mcpOperations" : "graphqlOperations";
    const methods = [
      ...(auth.oauth ? [`oauth: oauth2(${serialize(auth.oauth)})`] : []),
      ...(auth.apiKey
        ? [
            'apiKey: secrets({ label: "API key", fields: object({ token: string({ minLength: 1 }) }) })',
          ]
        : []),
      ...(auth.public
        ? ['public: secrets({ label: "No authentication (public server)", fields: object({}) })']
        : []),
    ];
    const keyHeader = auth.apiKey
      ? `{ [${serialize(auth.apiKey.header)}]: ${serialize(auth.apiKey.prefix)} + account.fields.token }`
      : undefined;
    const oauthHeader = '{ Authorization: "Bearer " + account.fields.access_token }';
    const authenticatedHeaders =
      auth.oauth && auth.apiKey
        ? `account.method === "oauth" ? ${oauthHeader} : ${keyHeader}`
        : auth.oauth
          ? oauthHeader
          : keyHeader;
    const headers =
      auth.public && authenticatedHeaders !== undefined
        ? `account.method === "public" ? {} : ${authenticatedHeaders}`
        : authenticatedHeaders;
    return {
      files: yield* sourceFiles([
        {
          path: "index.ts",
          content: `import { defineApp${methods.length ? ", accountOperations" : ""} } from "apps"\nimport { ${helper} } from "apps/${kind}"\n${methods.length ? 'import { provider } from "./provider.ts"\n' : ""}\nexport default defineApp({ accounts: ${methods.length ? "{ service: provider.many() }" : "{}"} }, async ({ accounts, signal }) =>\n  ${methods.length ? "accountOperations(accounts.service, async (account) => " : ""}${helper}({\n    url: ${serialize(url)},\n${headers ? `    headers: ${headers},\n` : ""}    signal,\n  })${methods.length ? ", { signal })" : ""},\n)\n`,
        },
        ...(methods.length
          ? [
              {
                path: "provider.ts",
                content: `import { defineProvider, object, string, secrets, oauth2 } from "apps"\n\nexport const provider = defineProvider({\n  name: ${serialize(name)},\n  auth: {\n    ${methods.join(",\n    ")}\n  },\n})\n`,
              },
            ]
          : []),
        packageFile(
          name,
          kind === "mcp" ? { "@modelcontextprotocol/sdk": "1.30.0" } : { graphql: "16.11.0" },
        ),
      ]),
    };
  });
