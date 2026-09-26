/**
 * App source written the way the app-authoring skill tells an agent to write it. The product
 * deploys and runs it through the ordinary deployment API; nothing here imports product code.
 */
export type AuthoredKind = "openapi" | "mcp" | "graphql";

const serialize = (value: unknown) => JSON.stringify(value, null, 2);

const provider = (name: string) => `import { defineProvider, object, secrets, string } from "apps";

export const provider = defineProvider({
  name: ${serialize(name)},
  auth: {
    apiKey: secrets({ label: "API key", fields: object({ token: string({ minLength: 1 }) }) }),
  },
});
`;

const packageFile = (dependencies: Record<string, string>) => ({
  path: "package.json",
  content: serialize({ name: "authored-app", private: true, type: "module", dependencies }),
});

/**
 * The skill's OpenAPI template. `key` names the security scheme an API-key account fills; without
 * it the app is public and declares no account.
 */
const openapiIndex = (options: {
  /** The definition's URL, or the definition itself when the app embeds it. */
  readonly url: string | { readonly document: unknown };
  readonly allowedOrigin: string;
  readonly baseUrl?: string;
  readonly securitySchemes: Record<string, unknown>;
  readonly key?: string;
}) => {
  const authenticated = options.key !== undefined;
  const configuration = {
    source: typeof options.url === "string" ? { url: options.url } : options.url,
    allowedOrigin: options.allowedOrigin,
    ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
    securitySchemes: options.securitySchemes,
    methods: authenticated
      ? { apiKey: [{ scheme: options.key, field: "token", part: "value", prefix: "" }] }
      : {},
    oauth: [],
  };
  return `import { ${authenticated ? "accountOperations, " : ""}defineApp } from "apps";
import { liveOpenapiOperations } from "apps/openapi";
${authenticated ? 'import { provider } from "./provider.ts";\n' : ""}
const configuration = ${serialize(configuration)} as const;

export default defineApp({ accounts: ${authenticated ? "{ service: provider.many() }" : "{}"} }, async ({ accounts, cache, fetch, signal }) =>
  ${
    authenticated
      ? "accountOperations(accounts.service, async (account) => liveOpenapiOperations({ ...configuration, cache, fetch, signal, account }), { signal })"
      : "liveOpenapiOperations({ ...configuration, cache, fetch, signal })"
  },
);
`;
};

/** A complete OpenAPI app, as the skill documents it, for a fixture definition. */
export const openapiAppFiles = (name: string, options: Parameters<typeof openapiIndex>[0]) => [
  { path: "index.ts", content: openapiIndex(options) },
  ...(options.key === undefined ? [] : [{ path: "provider.ts", content: provider(name) }]),
  packageFile({}),
];

/** Bearer-token apps select accounts with `provider.many()`; public apps declare none. */
export const authoredAppFiles = (
  kind: AuthoredKind,
  origin: string,
  access: "apiKey" | "public",
  name = `Authored ${kind}`,
) => {
  const authenticated = access === "apiKey";
  const wrap = (call: string) =>
    authenticated
      ? `accountOperations(accounts.service, async (account) => ${call}, { signal })`
      : call;
  const imports = (helper: string, path: string) =>
    [
      `import { ${authenticated ? "accountOperations, " : ""}defineApp } from "apps";`,
      `import { ${helper} } from "${path}";`,
      ...(authenticated ? ['import { provider } from "./provider.ts";'] : []),
    ].join("\n");
  const accountsDeclaration = authenticated ? "{ service: provider.many() }" : "{}";
  const headers = authenticated
    ? `headers: { Authorization: "Bearer " + account.fields.token },`
    : "";
  const index = (() => {
    switch (kind) {
      case "openapi":
        return openapiIndex({
          url: `${origin}/openapi.json`,
          allowedOrigin: origin,
          baseUrl: origin,
          securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
          ...(authenticated ? { key: "bearer" } : {}),
        });
      case "mcp":
      case "graphql": {
        const helper = kind === "mcp" ? "mcpOperations" : "graphqlOperations";
        return `${imports(helper, `apps/${kind}`)}

export default defineApp({ accounts: ${accountsDeclaration} }, async ({ accounts, cache, signal }) =>
  ${wrap(`${helper}({
    url: ${serialize(`${origin}/${kind}`)},
    cache: ${authenticated ? "cache.forAccount(account)" : "cache"},
    ${authenticated ? "accountId: account.id," : ""}
    ${headers}
    signal,
  })`)},
);
`;
      }
    }
  })();
  return [
    { path: "index.ts", content: index },
    ...(authenticated ? [{ path: "provider.ts", content: provider(name) }] : []),
    packageFile(
      kind === "mcp"
        ? { "@modelcontextprotocol/sdk": "1.30.0" }
        : kind === "graphql"
          ? { graphql: "16.11.0" }
          : {},
    ),
  ];
};

/** The source quick add generates for an OAuth MCP server, deployed without re-checking the server. */
export const oauthMcpAppFiles = (name: string, url: string) => [
  {
    path: "index.ts",
    content: `import { accountOperations, defineApp } from "apps";
import { mcpOperations } from "apps/mcp";
import { provider } from "./provider.ts";

export default defineApp({ accounts: { service: provider.many() } }, async ({ accounts, cache, signal }) =>
  accountOperations(accounts.service, async (account) => mcpOperations({
    url: ${serialize(url)},
    cache: cache.forAccount(account),
    accountId: account.id,
    headers: { Authorization: "Bearer " + account.fields.access_token },
    signal,
  }), { signal }),
);
`,
  },
  {
    path: "provider.ts",
    content: `import { defineProvider, oauth2 } from "apps";

export const provider = defineProvider({
  name: ${serialize(name)},
  auth: { oauth: oauth2({ discover: ${serialize(url)} }) },
});
`,
  },
  packageFile({ "@modelcontextprotocol/sdk": "1.30.0" }),
];
