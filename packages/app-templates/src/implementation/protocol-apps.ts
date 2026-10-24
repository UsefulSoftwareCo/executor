/**
 * Source for protocol apps whose sign-in methods, fixed request values and tool rules are known
 * up front, such as apps imported from another product. Everything stays in editable files:
 * `provider.ts` declares the methods and where each account's credentials go, `tools.ts` the
 * exposed names and approvals, `index.ts` the router.
 */
import { Effect, Schema } from "effect";
import { CredentialHost } from "apps/contracts";
import type { OpenapiSourceOptions } from "apps/openapi";
import { asciiJson } from "@executor-js/sdk/core";
import {
  TemplateError,
  type CredentialPlacement,
  type GeneratedAuthMethod,
  type GeneratedFixedAccount,
  type GeneratedHealthCheck,
  type GeneratedToolRules,
  type ProtocolAppOptions,
} from "../contracts/templates.ts";
import { appsPeerVersion, packageFile, sourceFiles } from "./files.ts";

const json = (value: unknown) => JSON.stringify(value, null, 2);
const key = (name: string) => `[${JSON.stringify(name)}]`;
const failed = (reason: string) => new TemplateError({ code: "source_generation", reason });

/** The host credentials may be sent to, from the URL the app calls. */
export const credentialHost = (url: string) =>
  Effect.try(() => new URL(url).host).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(CredentialHost)),
    Effect.mapError(() =>
      failed("The service URL has no host that credentials can be limited to."),
    ),
  );

const methodDeclaration = (method: GeneratedAuthMethod) =>
  method.kind === "secrets"
    ? `secrets({ label: ${JSON.stringify(method.label)}, fields: object({ ${method.fields
        .map((field) => `${key(field)}: string({ minLength: 1 })`)
        .join(", ")} }) })`
    : `oauth2(${json(method.oauth)})`;

const accountType = (name: string, method: GeneratedAuthMethod) =>
  `{ readonly method: ${JSON.stringify(name)}; readonly fields: { ${(method.kind === "secrets"
    ? method.fields
    : ["access_token"]
  )
    .map((field) => `readonly ${key(field)}: string`)
    .join("; ")} } }`;

const sentValues = (method: GeneratedAuthMethod) => {
  const placements: readonly CredentialPlacement[] =
    method.kind === "secrets"
      ? method.placements
      : [
          {
            carrier: "header" as const,
            name: method.header,
            prefix: method.prefix,
            field: "access_token",
          },
        ];
  const value = (placement: CredentialPlacement) => {
    const before =
      placement.prefixField !== undefined
        ? `account.fields${key(placement.prefixField)} + `
        : placement.prefix
          ? `${JSON.stringify(placement.prefix)} + `
          : "";
    return placement.literal !== undefined
      ? `${before}${JSON.stringify(placement.literal)}`
      : `${before}account.fields${key(placement.field ?? "")}`;
  };
  const entries = (carrier: "header" | "query") =>
    placements
      .filter((placement) => placement.carrier === carrier)
      .map((placement) => `${key(placement.name)}: ${value(placement)}`)
      .join(", ");
  return `{ headers: { ${entries("header")} }, query: { ${entries("query")} } }`;
};

/** The fixed account's sign-in method: its fields, sent where the placements say. */
const fixedMethod = (fixed: GeneratedFixedAccount): GeneratedAuthMethod => ({
  kind: "secrets",
  label: "Fixed credentials",
  fields: fixed.fields,
  placements: fixed.placements,
});

/**
 * The second provider of an app with a fixed account, the account's type, and
 * `requestCredentials`, which sends the selected account's credentials over the fixed ones, as v1
 * sent a connection's over its integration's.
 */
const fixedDeclarations = (
  name: string,
  fixed: GeneratedFixedAccount,
  hosts: readonly string[],
) => {
  const method = fixedMethod(fixed);
  return `
/**
 * Credentials every request sends beside the selected account's, held by one account the app's
 * managers link for everyone. They go only to the same hosts.
 */
export const fixedProvider = defineProvider({
  name: ${JSON.stringify(`${name} fixed credentials`)},
  hosts: [${hosts.map((host) => JSON.stringify(host)).join(", ")}],
  auth: {
    fixed: ${methodDeclaration(method)},
  },
})

/** The fixed credentials' account. */
export type FixedAccount = ${accountType("fixed", method)}

/** The headers and query parameters that send the fixed account's credentials. */
export const fixedCredentials = (
  account: FixedAccount,
): { readonly headers: Record<string, string>; readonly query: Record<string, string> } => (${sentValues(method)})

/** The selected account's credentials, sent over the fixed account's. */
export const requestCredentials = (account: Account, fixedAccount: FixedAccount) => {
  const own = credentials(account)
  const shared = fixedCredentials(fixedAccount)
  return { headers: { ...shared.headers, ...own.headers }, query: { ...shared.query, ...own.query } }
}
`;
};

/** The value at a path of a response body as a non-empty string of at most 255 characters. */
const identityCode = (
  identity: NonNullable<Extract<GeneratedHealthCheck, { kind: "request" }>["identity"]>,
) => `
  // The account's name is at \`${identity.path.join(".")}\` in the response.
  let value: unknown = await response.json().catch(() => undefined)
  for (const segment of ${JSON.stringify(identity.path)})
    value = Array.isArray(value)
      ? value[Number(segment)]
      : typeof value === "object" && value !== null
        ? (value as Record<string, unknown>)[segment]
        : undefined
  const name =
    typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" ? String(value) : ""
  if (name === "" || name.length > 255) return {}
  return { accountInfo: /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(name) ? { email: name } : { ${identity.as}: name } }`;

/**
 * A check sends an account's credentials, so it never follows a redirect: the next hop could be
 * another host or plain HTTP. A redirect fails the check instead of passing it.
 */
const redirectFailure = (indent: string) =>
  `\n${indent}if (response.status >= 300 && response.status < 400)\n${indent}  throw new Error(\`The service redirected the check (HTTP \${response.status}); an account's credentials never follow a redirect.\`)`;

/** Refused credentials fail a check; the other statuses say why the service did not answer. */
const statusFailures = (indent: string) =>
  [
    `if (response.status === 429) throw new ProviderError({ reason: "rate_limited", status: 429 })`,
    `if (response.status >= 500) throw new ProviderError({ reason: "unavailable", status: response.status })`,
    `if (!response.ok) throw new ProviderError({ reason: "rejected", status: response.status })`,
  ]
    .map((line) => `\n${indent}${line}`)
    .join("");

const checkContext = `{
  account,
  fetch,
  signal,
}: {
  readonly account: Account
  readonly fetch: typeof globalThis.fetch
  readonly signal: AbortSignal
})`;

/** The provider's `health` and the code it runs, for a request or a GraphQL check. */
const healthCode = (health: GeneratedHealthCheck, url: string | undefined) => {
  if (health.kind === "graphql")
    return {
      health: `// Check an account by introspecting the endpoint's schema with it.
  health: (check) => checkAccount(check),`,
      body: `
const endpoint = ${JSON.stringify(url)}
/** The schema introspection that checks an account. */
const introspection = ${JSON.stringify(health.query)}
/** Error text that blames the credentials. */
const refusal =
  /authoriz|authenticat|forbidden|permission|credential|api.?key|access denied|access token|invalid token|token expired|logged in|sign in/i

/**
 * Introspect with an account: refused credentials and redirects fail the check; any schema passes it.
 */
const checkAccount = async (${checkContext} => {
  const sent = credentials(account)
  const url = new URL(endpoint)
  for (const [name, value] of Object.entries({ ...fixed.query, ...sent.query })) url.searchParams.set(name, value)
  const response = await fetch(url, {
    method: "POST",
    signal,
    redirect: "manual",
    headers: { "Content-Type": "application/json", Accept: "application/json", ...fixed.headers, ...sent.headers },
    body: JSON.stringify({ query: introspection }),
  })${redirectFailure("  ")}
  const text = await response.text()
  let body: { readonly data?: { readonly __schema?: unknown }; readonly errors?: unknown; readonly message?: unknown } | undefined
  try {
    body = JSON.parse(text)
  } catch {
    body = undefined
  }
  const errors: readonly unknown[] = Array.isArray(body?.errors) ? body.errors : []
  const messages = errors.map((error) =>
    typeof error === "object" && error !== null ? (error as { message?: unknown }).message : undefined,
  )
  const message =
    messages.find((item): item is string => typeof item === "string") ??
    (typeof body?.message === "string" ? body?.message : text)
  if (response.status === 401 || response.status === 403)
    throw new ProviderError({ reason: "unauthorized", status: response.status })
  if (response.status !== 200) {
    if (refusal.test(message)) throw new ProviderError({ reason: "unauthorized", status: response.status })${statusFailures("    ")}
  }
  if (body === undefined) throw new Error("The GraphQL endpoint did not answer with JSON.")
  if (errors.length > 0) {
    if (refusal.test(message)) throw new ProviderError({ reason: "unauthorized" })
    throw new Error("Schema introspection returned GraphQL errors.")
  }
  if (body.data?.__schema === undefined || body.data.__schema === null)
    throw new Error("The GraphQL endpoint answered without a schema.")
  return {}
}
`,
    };
  const { description, identity, ...request } = health;
  return {
    health: `// Check an account with ${description}.
  health: (check) => checkAccount(check),`,
    body: `
/** The request that checks an account: ${description}. Credentials and fixed values are added. */
const check: {
  readonly method: string
  readonly url: string
  readonly query: ReadonlyArray<readonly [string, string]>
  readonly headers: Record<string, string>
  readonly body?: string
} = ${json({ method: request.method, url: request.url, query: request.query, headers: request.headers, ...(request.body === undefined ? {} : { body: request.body }) })}

/** Whether a Google-style 403 blames the service's own setup, such as an API that is not enabled. */
const configurationRefusal = (body: unknown) => {
  const error = typeof body === "object" && body !== null ? (body as { error?: unknown }).error : undefined
  if (typeof error !== "object" || error === null) return false
  return ["errors", "details"].some((key) => {
    const entries = (error as Record<string, unknown>)[key]
    return (
      Array.isArray(entries) &&
      entries.some((entry: unknown) => {
        const reason = typeof entry === "object" && entry !== null ? (entry as { reason?: unknown }).reason : undefined
        return typeof reason === "string" && ["accessnotconfigured", "service_disabled"].includes(reason.toLowerCase())
      })
    )
  })
}

/**
 * Send the check with an account. 401 and 403 refuse its credentials, unless the 403 says the
 * service is not set up for them (\`forbidden\`), which connecting again would not fix. A redirect
 * fails it, without sending the credentials on.
 */
const checkAccount = async (${checkContext} => {
  const sent = credentials(account)
  const url = new URL(check.url)
  for (const [name, value] of Object.entries({ ...fixed.query, ...sent.query })) url.searchParams.set(name, value)
  for (const [name, value] of check.query) url.searchParams.append(name, value)
  const response = await fetch(url, {
    method: check.method,
    signal,
    redirect: "manual",
    headers: { ...check.headers, ...fixed.headers, ...sent.headers },
    ...(check.body === undefined ? {} : { body: check.body }),
  })${redirectFailure("  ")}
  if (response.status === 401 || response.status === 403) {
    const body: unknown = await response.json().catch(() => undefined)
    throw new ProviderError({
      reason: response.status === 403 && configurationRefusal(body) ? "forbidden" : "unauthorized",
      status: response.status,
    })
  }${statusFailures("  ")}${identity === undefined ? "\n  return {}" : identityCode(identity)}
}
`,
  };
};

/**
 * `provider.ts`: the provider, the account shape app code receives, `credentials`, which returns
 * the headers and query parameters that send an account's credentials, and the app's fixed
 * values. A `health` check from the options, or the caller's own, checks accounts.
 */
export const providerFile = (
  options: ProtocolAppOptions & { readonly url?: string },
  hosts: readonly string[],
  extra: { readonly imports?: string; readonly body?: string; readonly health?: string } = {},
) => {
  const methods = Object.entries(options.methods);
  const fixed = options.fixedAccount;
  // A check gets only its own account, so it cannot send the fixed account's credentials.
  const generated =
    extra.health === undefined && options.health !== undefined && fixed === undefined
      ? healthCode(options.health, options.url)
      : undefined;
  const constructors = [
    ...new Set([
      ...methods.flatMap(([, method]) =>
        method.kind === "secrets" ? ["object", "secrets", "string"] : ["oauth2"],
      ),
      ...(fixed === undefined ? [] : ["object", "secrets", "string"]),
      ...(generated === undefined ? [] : ["ProviderError"]),
    ]),
  ].sort();
  const health = fixed === undefined ? (extra.health ?? generated?.health) : undefined;
  return `import { defineProvider, ${constructors.join(", ")} } from "apps"
${extra.imports ?? ""}
export const provider = defineProvider({
  name: ${JSON.stringify(options.name)},
  // Credentials are only ever sent to the service itself.
  hosts: [${hosts.map((host) => JSON.stringify(host)).join(", ")}],
  auth: {
${methods.map(([name, method]) => `    ${key(name)}: ${methodDeclaration(method)},`).join("\n")}
  },${health === undefined ? "" : `\n  ${health}`}
})

/** A selected account, by sign-in method. */
export type Account =
${methods.map(([name, method]) => `  | ${accountType(name, method)}`).join("\n")}

/** The headers and query parameters that send an account's credentials. */
export const credentials = (
  account: Account,
): { readonly headers: Record<string, string>; readonly query: Record<string, string> } => {
  switch (account.method) {
${methods.map(([name, method]) => `    case ${JSON.stringify(name)}:\n      return ${sentValues(method)}`).join("\n")}
  }
}

/** Fixed, non-credential headers and query parameters sent on every request. */
export const fixed = ${json({ headers: options.headers ?? {}, query: options.queryParams ?? {} })}
${fixed === undefined ? "" : fixedDeclarations(options.name, fixed, hosts)}${generated?.body ?? ""}${extra.body ?? ""}`;
};

const lowerSnake = `name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "tool"`;

/** `tools.ts`: exposed names and per-tool approvals, or undefined when there are no rules. */
export const toolsFile = (rules: GeneratedToolRules | undefined) => {
  if (rules === undefined) return undefined;
  const omitted = [...(rules.omitted ?? [])].sort();
  const approvals = rules.approvals ?? {};
  const names = rules.names;
  const overrides =
    names?.kind === "lower_snake" && Object.keys(names.overrides ?? {}).length > 0
      ? names.overrides
      : undefined;
  if (names === undefined && omitted.length === 0 && Object.keys(approvals).length === 0)
    return undefined;
  const exposed =
    names?.kind === "map"
      ? `const names: Record<string, string> = ${json(
          Object.fromEntries(
            Object.entries(names.names).filter(([, name]) => !omitted.includes(name)),
          ),
        )}

/** The name each tool is exposed under. Tools without one are left out. */
export const exposedName = (name: string): string | undefined =>
  Object.hasOwn(names, name) ? names[name] : undefined
`
      : `const omitted = new Set<string>(${json(omitted)})
${
  overrides === undefined
    ? ""
    : `/** Upstream names exposed under a name of their own instead of lower snake case. */
const overrides: Record<string, string> = ${json(overrides)}
`
}
/** The name each tool is exposed under. Omitted tools are left out. */
export const exposedName = (name: string): string | undefined => {
  const exposed = ${
    names?.kind === "lower_snake"
      ? overrides === undefined
        ? lowerSnake
        : `(Object.hasOwn(overrides, name) ? overrides[name] : undefined) ?? (${lowerSnake})`
      : names?.kind === "graphql_path"
        ? `name.replace(/^(query|mutation)_/, "$1.")`
        : "name"
  }
  return omitted.has(exposed) ? undefined : exposed
}
`;
  return `import { always, never } from "apps/operations/approval"

${exposed}
const approvals: Record<string, "always" | "never"> = ${json(
    Object.fromEntries(Object.entries(approvals).sort(([a], [b]) => (a < b ? -1 : 1))),
  )}

/** A tool's own approval rule, by exposed name, or undefined to use the app's default. */
export const approval = (name: string) =>
  approvals[name] === "always" ? always() : approvals[name] === "never" ? never() : undefined
`;
};

/**
 * Wrap a router expression with the tool rules: renamed and left out by `exposedName`, then each
 * tool's approval, falling back to `defaultRule`.
 */
const ruled = (router: string, rules: boolean, defaultRule: string) =>
  rules
    ? `withApprovals(renameTools(${router}, exposedName), (tool, name) => approval(name) ?? (${defaultRule}))`
    : `withApprovals(${router}, (tool) => (${defaultRule}))`;

const queryUrl = (url: string, query: Readonly<Record<string, string>> | undefined) => {
  const target = new URL(url);
  for (const [name, value] of Object.entries(query ?? {})) target.searchParams.set(name, value);
  return target.href;
};

/** A public server's fixed headers as a router option, when it has any. */
const publicHeaders = (headers: Readonly<Record<string, string>> | undefined) =>
  Object.keys(headers ?? {}).length === 0 ? "" : `headers: ${JSON.stringify(headers)}, `;

const appImports = (names: readonly string[]) =>
  `import { ${[...new Set(names)].sort().join(", ")} } from "apps"`;

/**
 * The account requirements an app with sign-in methods declares, the factory's parameters for
 * them, the accounts its tools take one of, and the expression for one account's credentials:
 * each member's own accounts (`service`), with `sharedAccounts` also those linked for everyone
 * (`workspace`), and with a fixed account the one account linked for everyone that holds the fixed
 * credentials (`fixed`), sent under the selected account's. An account linked in both scopes is
 * offered once.
 */
const accountScopes = (options: Pick<ProtocolAppOptions, "sharedAccounts" | "fixedAccount">) => {
  const shared = options.sharedAccounts === true;
  const fixed = options.fixedAccount !== undefined;
  const app = [
    ...(shared ? ["workspace: provider.many()"] : []),
    ...(fixed ? ["fixed: fixedProvider"] : []),
  ];
  return {
    requirements: `{ ${app.length === 0 ? "" : `app: { accounts: { ${app.join(", ")} } }, `}user: { accounts: { service: provider.many() } } }`,
    context: app.length === 0 ? "user" : "app, user",
    accounts: shared
      ? `[...app.accounts.workspace, ...(user?.accounts.service ?? []).filter((account) => !app.accounts.workspace.some((shared) => shared.id === account.id))]`
      : "user?.accounts.service ?? []",
    /** The provider file's names the app's index imports. */
    imports: fixed ? ["fixedProvider", "requestCredentials"] : ["credentials"],
    sent: (account: string) =>
      fixed ? `requestCredentials(${account}, app.accounts.fixed)` : `credentials(${account})`,
  };
};

/** An MCP server app for known sign-in methods, fixed headers and query parameters. */
export const mcpAppSource = (options: ProtocolAppOptions & { readonly url: string }) =>
  Effect.gen(function* () {
    const tools = toolsFile(options.tools);
    const rules = tools !== undefined;
    const accounts = Object.keys(options.methods).length > 0;
    const defaultRule = `toolAnnotations(tool)?.destructiveHint === true ? always() : undefined`;
    const scopes = accountScopes(options);
    const fixedAccount = accounts && options.fixedAccount !== undefined;
    const fixedUrl = yield* Effect.try({
      try: () => queryUrl(options.url, options.queryParams),
      catch: () => failed("The MCP server URL is not valid."),
    });
    const routerImports = [
      "toolAnnotations",
      "withApprovals",
      ...(rules ? ["renameTools"] : []),
      ...(accounts ? ["accountRouter"] : []),
    ];
    const index = accounts
      ? `${appImports(["defineApp", ...routerImports])}
import { mcpRouter } from "apps/mcp"
import { always } from "apps/operations/approval"
import { ${fixedAccount ? "fixedProvider, " : ""}provider, target } from "./provider.ts"
${rules ? `import { approval, exposedName } from "./tools.ts"\n` : ""}
export default defineApp(${scopes.requirements}, async ({ ${scopes.context}, signal, cache }) => ({
  tools: await accountRouter(${scopes.accounts}, async (account) => {
    const request = target(account${fixedAccount ? ", app.accounts.fixed" : ""})
    return ${ruled(
      "await mcpRouter({ url: request.url, account, cache, headers: request.headers, signal })",
      rules,
      defaultRule,
    )}
  }, { signal }),
}))
`
      : `${appImports(["defineApp", ...routerImports])}
import { mcpRouter } from "apps/mcp"
import { always } from "apps/operations/approval"
${rules ? `import { approval, exposedName } from "./tools.ts"\n` : ""}
export default defineApp({}, async ({ signal, cache }) => ({
  tools: ${ruled(`await mcpRouter({ url: ${JSON.stringify(fixedUrl)}, ${publicHeaders(options.headers)}cache, signal })`, rules, defaultRule)},
}))
`;
    const host = accounts ? yield* credentialHost(options.url) : undefined;
    const provider =
      host === undefined
        ? undefined
        : providerFile(
            options,
            [host],
            fixedAccount
              ? {
                  body: `
export const url = ${JSON.stringify(options.url)}

/** The URL and headers one account's requests use, with the fixed account's credentials. */
export const target = (account: Account, fixedAccount: FixedAccount) => {
  const sent = requestCredentials(account, fixedAccount)
  const url = new URL(${JSON.stringify(options.url)})
  for (const [name, value] of Object.entries({ ...fixed.query, ...sent.query })) url.searchParams.set(name, value)
  return { url: url.href, headers: { ...fixed.headers, ...sent.headers } }
}
`,
                }
              : {
                  imports: `import { mcpHealth } from "apps/mcp"\n`,
                  health: `// Check an account by connecting to the server with it and listing its tools.
  health: (check) => mcpHealth(check, target(check.account)),`,
                  body: `
export const url = ${JSON.stringify(options.url)}

/** The URL and headers one account's requests use. */
export const target = (account: Account) => {
  const sent = credentials(account)
  const url = new URL(${JSON.stringify(options.url)})
  for (const [name, value] of Object.entries({ ...fixed.query, ...sent.query })) url.searchParams.set(name, value)
  return { url: url.href, headers: { ...fixed.headers, ...sent.headers } }
}
`,
                },
          );
    return {
      files: yield* sourceFiles([
        { path: "index.ts", content: index },
        ...(provider === undefined ? [] : [{ path: "provider.ts", content: provider }]),
        ...(tools === undefined ? [] : [{ path: "tools.ts", content: tools }]),
        packageFile(options.name, {
          "@modelcontextprotocol/sdk": appsPeerVersion("@modelcontextprotocol/sdk"),
        }),
      ]),
    };
  });

/**
 * An OpenAPI app over an inline document with `liveOpenapiRouter`. Requests to `allowedOrigins` get
 * the fixed headers and query parameters, and the selected account's credentials, in a `fetch`
 * wrapper; the document declares no security of its own. Without `baseUrl`, each operation is
 * sent to its own server, as the document declares it.
 */
export const openapiAppSource = (
  options: ProtocolAppOptions &
    (
      | { readonly document: Readonly<Record<string, unknown>>; readonly sourceUrl?: never }
      /** Public definitions are fetched live without sending account credentials. */
      | { readonly sourceUrl: string; readonly document?: never }
    ) & {
      readonly security?: Pick<OpenapiSourceOptions, "securitySchemes" | "methods" | "oauth">;
      readonly baseUrl?: string | undefined;
      /**
       * The origins operations are sent to, which receive the credentials and are the provider's
       * hosts. Operations on any other origin are left out.
       */
      readonly allowedOrigins: readonly [string, ...string[]];
    },
) =>
  Effect.gen(function* () {
    const tools = toolsFile(options.tools);
    const rules = tools !== undefined;
    const accounts = Object.keys(options.methods).length > 0;
    const origins = yield* Effect.try({
      try: () => [...new Set(options.allowedOrigins.map((origin) => new URL(origin).origin))],
      catch: () => failed("The API origin is not valid."),
    });
    const defaultRule = `tool.kind === "mutation" ? always() : undefined`;
    const scopes = accountScopes(options);
    const routerImports = [
      "withApprovals",
      ...(rules ? ["renameTools"] : []),
      ...(accounts ? ["accountRouter"] : []),
    ];
    const router = `liveOpenapiRouter({
      ...configuration,
      cache,
      fetch: ${options.security === undefined ? `send(fetch, ${accounts ? scopes.sent("account") : "{ headers: {}, query: {} }"})` : "fetch"},
      ${accounts && options.security !== undefined ? "account," : ""}
      ...(signal === undefined ? {} : { signal }),
    })`;
    const index = `${appImports(["defineApp", ...routerImports])}
import { liveOpenapiRouter } from "apps/openapi"
import { always } from "apps/operations/approval"
import configuration from "./openapi.json"
${accounts ? `import { ${[...(options.security === undefined ? [...scopes.imports, "fixed"] : []), "provider"].sort().join(", ")} } from "./provider.ts"\n` : ""}${rules ? `import { approval, exposedName } from "./tools.ts"\n` : ""}${
      accounts || options.security !== undefined
        ? ""
        : `
const fixed = ${json({ headers: options.headers ?? {}, query: options.queryParams ?? {} })}
`
    }
${
  options.security === undefined
    ? `/** Add the fixed values and an account's credentials to requests for the API's origins only. */
const send =
  (
    fetch: typeof globalThis.fetch,
    sent: { readonly headers: Record<string, string>; readonly query: Record<string, string> },
  ): typeof globalThis.fetch =>
  (input, init) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    if (${origins.length === 1 ? "url.origin !== configuration.allowedOrigin" : "!configuration.allowedOrigin.includes(url.origin)"}) return fetch(request)
    for (const [name, value] of Object.entries({ ...fixed.query, ...sent.query })) url.searchParams.set(name, value)
    const sending = new Request(url, request)
    for (const [name, value] of Object.entries({ ...fixed.headers, ...sent.headers })) sending.headers.set(name, value)
    return fetch(sending)
  }`
    : ""
}

${
  accounts
    ? `export default defineApp(${scopes.requirements}, async ({ ${scopes.context}, cache, fetch, signal }) => ({
  tools: await accountRouter(${scopes.accounts}, (account) =>
    ${ruled(router, rules, defaultRule)},
    { signal },
  ),
}))`
    : `export default defineApp({}, async ({ cache, fetch, signal }) => ({
  tools: ${ruled(router, rules, defaultRule)},
}))`
}
`;
    const hosts = accounts
      ? [...new Set(yield* Effect.forEach(origins, (origin) => credentialHost(origin)))]
      : undefined;
    return {
      files: yield* sourceFiles([
        { path: "index.ts", content: index },
        {
          path: "openapi.json",
          // The document is written without indentation, which would more than double a large
          // API's source; the settings after it stay one per line. The whole file is ASCII, so a
          // non-ASCII base URL or description cannot double the memory of the document's text.
          content: asciiJson(
            `{\n  "source": ${JSON.stringify(options.sourceUrl === undefined ? { document: options.document } : { url: options.sourceUrl })},\n${json(
              {
                allowedOrigin: origins.length === 1 ? origins[0] : origins,
                securitySchemes: {},
                methods: {},
                oauth: [],
                ...options.security,
                ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
              },
            ).slice(2)}`,
          ),
        },
        ...(hosts === undefined
          ? []
          : [{ path: "provider.ts", content: providerFile(options, hosts) }]),
        ...(tools === undefined ? [] : [{ path: "tools.ts", content: tools }]),
        packageFile(options.name),
      ]),
    };
  });

/** A GraphQL app on `graphqlRouter`; the schema is introspected with each account. */
export const graphqlAppSource = (options: ProtocolAppOptions & { readonly url: string }) =>
  Effect.gen(function* () {
    const tools = toolsFile(options.tools);
    const rules = tools !== undefined;
    const accounts = Object.keys(options.methods).length > 0;
    const fixedUrl = yield* Effect.try({
      try: () => queryUrl(options.url, options.queryParams),
      catch: () => failed("The GraphQL endpoint is not valid."),
    });
    const defaultRule = `tool.kind === "mutation" ? always() : undefined`;
    const scopes = accountScopes(options);
    const routerImports = [
      "withApprovals",
      ...(rules ? ["renameTools"] : []),
      ...(accounts ? ["accountRouter"] : []),
    ];
    const index = accounts
      ? `${appImports(["defineApp", ...routerImports])}
import { graphqlRouter } from "apps/graphql"
import { always } from "apps/operations/approval"
import { ${[...scopes.imports, "fixed", "provider"].sort().join(", ")} } from "./provider.ts"
${rules ? `import { approval, exposedName } from "./tools.ts"\n` : ""}
export default defineApp(${scopes.requirements}, async ({ ${scopes.context}, signal, cache }) => ({
  tools: await accountRouter(${scopes.accounts}, async (account) => {
    const sent = ${scopes.sent("account")}
    const url = new URL(${JSON.stringify(options.url)})
    for (const [name, value] of Object.entries({ ...fixed.query, ...sent.query })) url.searchParams.set(name, value)
    return ${ruled(
      "await graphqlRouter({ url: url.href, account, cache, headers: { ...fixed.headers, ...sent.headers }, signal })",
      rules,
      defaultRule,
    )}
  }, { signal }),
}))
`
      : `${appImports(["defineApp", ...routerImports])}
import { graphqlRouter } from "apps/graphql"
import { always } from "apps/operations/approval"
${rules ? `import { approval, exposedName } from "./tools.ts"\n` : ""}
export default defineApp({}, async ({ signal, cache }) => ({
  tools: ${ruled(`await graphqlRouter({ url: ${JSON.stringify(fixedUrl)}, ${publicHeaders(options.headers)}cache, signal })`, rules, defaultRule)},
}))
`;
    const host = accounts ? yield* credentialHost(options.url) : undefined;
    return {
      files: yield* sourceFiles([
        { path: "index.ts", content: index },
        ...(host === undefined
          ? []
          : [{ path: "provider.ts", content: providerFile(options, [host]) }]),
        ...(tools === undefined ? [] : [{ path: "tools.ts", content: tools }]),
        packageFile(options.name, { graphql: appsPeerVersion("graphql") }),
      ]),
    };
  });
