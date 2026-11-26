import { withApps, mcpSdkVersion } from "./apps-release.ts";

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
  content: serialize({
    name: "authored-app",
    private: true,
    type: "module",
    dependencies: withApps(dependencies),
  }),
});

const openapiIndex = (options: {
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
  return `import { ${authenticated ? "accountRouter, " : ""}defineApp } from "apps";
import { liveOpenapiRouter } from "apps/openapi";
${authenticated ? 'import { provider } from "./provider.ts";\n' : ""}
const configuration = ${serialize(configuration)} as const;

export default defineApp(${authenticated ? "{ user: { accounts: { service: provider.many() } } }" : "{}"}, async ({ ${authenticated ? "user, " : ""}cache, fetch, signal }) => ({
  tools: ${
    authenticated
      ? "await accountRouter(user?.accounts.service ?? [], async (account) => liveOpenapiRouter({ ...configuration, cache, fetch, signal, account }), { signal })"
      : "liveOpenapiRouter({ ...configuration, cache, fetch, signal })"
  },
}));
`;
};

export const openapiAppFiles = (name: string, options: Parameters<typeof openapiIndex>[0]) => [
  { path: "index.ts", content: openapiIndex(options) },
  ...(options.key === undefined ? [] : [{ path: "provider.ts", content: provider(name) }]),
  packageFile({}),
];

export const authoredAppFiles = (
  kind: AuthoredKind,
  origin: string,
  access: "apiKey" | "public",
  name = `Authored ${kind}`,
) => {
  const authenticated = access === "apiKey";
  const wrap = (call: string) =>
    authenticated
      ? `accountRouter(user?.accounts.service ?? [], async (account) => ${call}, { signal })`
      : call;
  const imports = (helper: string, path: string) =>
    [
      `import { ${authenticated ? "accountRouter, " : ""}defineApp } from "apps";`,
      `import { ${helper} } from "${path}";`,
      ...(authenticated ? ['import { provider } from "./provider.ts";'] : []),
    ].join("\n");
  const requirements = authenticated
    ? "{ user: { accounts: { service: provider.many() } } }"
    : "{}";
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
        const helper = kind === "mcp" ? "mcpRouter" : "graphqlRouter";
        return `${imports(helper, `apps/${kind}`)}

export default defineApp(${requirements}, async ({ ${authenticated ? "user, " : ""}cache, signal }) => ({
  tools: await ${wrap(`${helper}({
    url: ${serialize(`${origin}/${kind}`)},
    cache,
    ${authenticated ? "account," : ""}
    ${headers}
    signal,
  })`)},
}));
`;
      }
    }
  })();
  return [
    { path: "index.ts", content: index },
    ...(authenticated ? [{ path: "provider.ts", content: provider(name) }] : []),
    packageFile(
      kind === "mcp"
        ? { "@modelcontextprotocol/sdk": mcpSdkVersion }
        : kind === "graphql"
          ? { graphql: "16.11.0" }
          : {},
    ),
  ];
};

export const oauthMcpAppFiles = (name: string, url: string) => [
  {
    path: "index.ts",
    content: `import { accountRouter, defineApp } from "apps";
import { mcpRouter } from "apps/mcp";
import { provider } from "./provider.ts";

export default defineApp({ user: { accounts: { service: provider.many() } } }, async ({ user, cache, signal }) => ({
  tools: await accountRouter(user?.accounts.service ?? [], async (account) => mcpRouter({
    url: ${serialize(url)},
    account,
    cache,
    headers: { Authorization: "Bearer " + account.fields.access_token },
    signal,
  }), { signal }),
}));
`,
  },
  {
    path: "provider.ts",
    content: `import { defineProvider, oauth2 } from "apps";

export const provider = defineProvider({
  name: ${serialize(name)},
  hosts: ${serialize([new URL(url).host])},
  auth: { oauth: oauth2({ discover: ${serialize(url)} }) },
});
`,
  },
  packageFile({ "@modelcontextprotocol/sdk": mcpSdkVersion }),
];
