import { Effect, Schema } from "effect";
import type { AccountScope } from "apps";
import { CredentialHost } from "apps/contracts";
import {
  TemplateError,
  type GeneratedAuthMethod,
  type GeneratedFixedAccount,
  type GeneratedToolRules,
} from "../contracts/templates.ts";
import { appsPeerVersion, packageFile, sourceFiles } from "./files.ts";
import { mcpAppSource } from "./protocol-apps.ts";

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

export type McpSourceAccess =
  | {
      readonly kind: "oauth";
      readonly discover: string;
      readonly accounts?: AccountScope;
    }
  | { readonly kind: "public"; readonly offersOAuth?: { readonly discover: string } }
  | { readonly kind: "methods"; readonly methods: Readonly<Record<string, GeneratedAuthMethod>> };

export interface McpSourceOptions {
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly queryParams?: Readonly<Record<string, string>> | undefined;
  readonly tools?: GeneratedToolRules | undefined;
  readonly appLinkedAccounts?: boolean | undefined;
  readonly fixedAccount?: GeneratedFixedAccount | undefined;
}

export const generateMcpSource = (
  name: string,
  url: string,
  access: McpSourceAccess,
  options: McpSourceOptions = {},
) =>
  Effect.gen(function* () {
    if (access.kind === "methods")
      return yield* mcpAppSource({ name, url, methods: access.methods, ...options });
    if (
      options.headers !== undefined ||
      options.queryParams !== undefined ||
      options.tools !== undefined
    )
      return yield* mcpAppSource({ name, url, methods: {}, ...options });
    const oauth = access.kind === "oauth" ? { discover: access.discover } : access.offersOAuth;
    const serialize = (value: unknown) => JSON.stringify(value, null, 2);
    const approvalRule = `
    // Ask before running tools the server marks destructive. Edit this rule to change which tools need approval.
    (tool) => (toolAnnotations(tool)?.destructiveHint === true ? always() : undefined),
  `;
    const index =
      access.kind === "public"
        ? `${
            oauth === undefined
              ? ""
              : `// This server works without sign-in and also offers OAuth sign-in. To connect accounts, declare
// \`user: { accounts: { service: provider.many() } }\` with the provider in ./provider.ts and send
// each account's token to mcpRouter, as Executor's OAuth MCP apps do.
`
          }import { defineApp, toolAnnotations, withApprovals } from "apps"
import { mcpRouter } from "apps/mcp"
import { always } from "apps/operations/approval"

export default defineApp({}, async ({ signal, cache }) => ({
  tools: withApprovals(await mcpRouter({
    url: ${serialize(url)},
    cache,
    signal,
  }),${approvalRule}),
}))
`
        : access.accounts === "app"
          ? `import { defineApp, toolAnnotations, withApprovals } from "apps"
import { mcpRouter } from "apps/mcp"
import { always } from "apps/operations/approval"
import { headers, provider, url } from "./provider.ts"

// One service account for the whole app: its managers link it for everyone, and every call uses it.
export default defineApp({ app: { accounts: { service: provider } } }, async ({ app, signal, cache }) => ({
  tools: withApprovals(await mcpRouter({
    url,
    account: app.accounts.service,
    cache,
    headers: headers(app.accounts.service),
    signal,
  }),${approvalRule}),
}))
`
          : `import { defineApp, accountRouter, toolAnnotations, withApprovals } from "apps"
import { mcpRouter } from "apps/mcp"
import { always } from "apps/operations/approval"
import { headers, provider, url } from "./provider.ts"

// Each member links their own accounts, and each tool takes the account to use.
export default defineApp({ user: { accounts: { service: provider.many() } } }, async ({ user, signal, cache }) => ({
  tools: await accountRouter(user?.accounts.service ?? [], async (account) => withApprovals(await mcpRouter({
    url,
    account,
    cache,
    headers: headers(account),
    signal,
  }),${approvalRule}), { signal }),
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
import { mcpHealth } from "apps/mcp"

export const url = ${serialize(url)}

/** The headers that send an account's token to the server. */
export const headers = (account: { fields: { access_token: string } }) => ({
  Authorization: "Bearer " + account.fields.access_token,
})

export const provider = defineProvider({
  name: ${serialize(name)},
  hosts: [${serialize(host)}],
  auth: {
    oauth: oauth2(${serialize(oauth)})
  },
  // Check an account by connecting to the server with it and listing its tools.
  health: (check) => mcpHealth(check, { url, headers: headers(check.account) }),
})
`,
              },
            ]
          : []),
        packageFile(name, {
          "@modelcontextprotocol/sdk": appsPeerVersion("@modelcontextprotocol/sdk"),
        }),
      ]),
    };
  });
