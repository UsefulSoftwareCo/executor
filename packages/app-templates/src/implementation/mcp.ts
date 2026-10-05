import { Effect, Schema } from "effect";
import { CredentialHost } from "apps/contracts";
import { TemplateError } from "../contracts/templates.ts";
import { appsPeerVersion, packageFile, sourceFiles } from "./files.ts";

/** The server's host, so an OAuth account's tokens are only ever sent to the server itself. */
const credentialHost = (url: string) =>
  Effect.try(() => new URL(url).host).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(CredentialHost)),
    Effect.mapError(
      () =>
        new TemplateError({
          code: "source_generation",
          reason: "The MCP server URL has no host that credentials can be limited to.",
        }),
    ),
  );

/**
 * A remote MCP app whose connection was confirmed: public, or OAuth discovered from the server.
 * All runtime behavior is retained in editable files and public app-framework helpers, including
 * the approval rule: tools the server marks `destructiveHint: true` ask before running. An OAuth
 * provider declares the server's host, so app code holds token handles rather than real values.
 */
export const generateMcpSource = (
  name: string,
  url: string,
  oauth?: { readonly discover: string },
) =>
  Effect.gen(function* () {
    const serialize = (value: unknown) => JSON.stringify(value, null, 2);
    // Each account's router is wrapped before accountRouter combines them, so every account keeps
    // its own tools' hints.
    const approvalRule = `
    // Ask before running tools the server marks destructive. Edit this rule to change which tools need approval.
    (tool) => (toolAnnotations(tool)?.destructiveHint === true ? always() : undefined),
  `;
    const index = oauth
      ? `import { defineApp, accountRouter, toolAnnotations, withApprovals } from "apps"
import { mcpRouter } from "apps/mcp"
import { always } from "apps/operations/approval"
import { provider } from "./provider.ts"

export default defineApp({ accounts: { service: provider.many() } }, async ({ accounts, signal, cache }) => ({
  tools: await accountRouter(accounts.service, async (account) => withApprovals(await mcpRouter({
    url: ${serialize(url)},
    account,
    cache,
    headers: { Authorization: "Bearer " + account.fields.access_token },
    signal,
  }),${approvalRule}), { signal }),
}))
`
      : `import { defineApp, toolAnnotations, withApprovals } from "apps"
import { mcpRouter } from "apps/mcp"
import { always } from "apps/operations/approval"

export default defineApp({ accounts: {} }, async ({ signal, cache }) => ({
  tools: withApprovals(await mcpRouter({
    url: ${serialize(url)},
    cache,
    signal,
  }),${approvalRule}),
}))
`;
    const host = oauth ? yield* credentialHost(url) : undefined;
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
  hosts: [${serialize(host)}],
  auth: {
    oauth: oauth2(${serialize(oauth)})
  },
})
`,
              },
            ]
          : []),
        packageFile(name, {
          "@modelcontextprotocol/client": appsPeerVersion("@modelcontextprotocol/client"),
          "@modelcontextprotocol/core": appsPeerVersion("@modelcontextprotocol/core"),
        }),
      ]),
    };
  });
