/**
 * v1's declared account checks (`integration.health_check`) as the request a generated provider
 * sends. v1's OpenAPI plugin invoked the declared operation with its pinned arguments, the
 * integration's fixed values and the connection's credentials (`checkHealthOpenApi`); the request
 * here is built the way v1's `buildRequest` built it, once, at import, since every input but the
 * credentials is fixed. v1's GraphQL plugin introspected the endpoint; MCP only listed tools, which
 * the generated `mcpHealth` already does.
 */
import type { GeneratedHealthCheck } from "@executor-js/app-templates";
import { Option, Schema } from "effect";
import { credentialLike, type HealthCheckSpec, type OpenApiConfig } from "./formats.ts";
import { plainHttpHosts } from "./openapi.ts";

/** A check the provider runs, or why v1's check is not carried over (the app has none then). */
export type HealthPlan =
  | { readonly ok: true; readonly check: GeneratedHealthCheck }
  | { readonly ok: false; readonly reason: string };
const none = (reason: string): HealthPlan => ({ ok: false, reason });

const Parameter = Schema.Struct({
  name: Schema.String,
  location: Schema.String,
  required: Schema.optional(Schema.Boolean),
  style: Schema.optional(Schema.String),
  explode: Schema.optional(Schema.Boolean),
  allowReserved: Schema.optional(Schema.Boolean),
});
type Parameter = typeof Parameter.Type;
const Server = Schema.Struct({
  url: Schema.String,
  variables: Schema.optional(
    Schema.Record(Schema.String, Schema.Struct({ default: Schema.optional(Schema.Unknown) })),
  ),
});
type Server = typeof Server.Type;
/** The parts of v1's stored `OperationBinding` its request builder reads. */
const Binding = Schema.Struct({
  method: Schema.String,
  pathTemplate: Schema.String,
  parameters: Schema.Array(Parameter),
  requestBody: Schema.optional(
    Schema.Struct({
      contentType: Schema.String,
      required: Schema.optional(Schema.Boolean),
      contents: Schema.optional(Schema.Array(Schema.Struct({ contentType: Schema.String }))),
    }),
  ),
  servers: Schema.optional(Schema.Array(Server)),
});

const containers: Record<string, readonly string[]> = {
  path: ["path", "pathParams", "params"],
  query: ["query", "queryParams", "params"],
  header: ["headers", "header"],
  cookie: ["cookies", "cookie"],
};
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** v1's `readParamValue`: by name, then inside the location's containers. */
const parameterValue = (args: Record<string, unknown>, parameter: Parameter): unknown => {
  if (args[parameter.name] !== undefined) return args[parameter.name];
  for (const key of containers[parameter.location] ?? []) {
    const container = args[key];
    if (isRecord(container) && container[parameter.name] !== undefined)
      return container[parameter.name];
  }
  return undefined;
};
const text = (value: unknown) =>
  typeof value === "object" && value !== null ? JSON.stringify(value) : String(value);
const reserved = /[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=]/u;
const encode = (raw: string, allowReserved: boolean) =>
  allowReserved
    ? [...raw]
        .map((character) => (reserved.test(character) ? character : encodeURIComponent(character)))
        .join("")
    : encodeURIComponent(raw);

/** v1's `queryParamEntries`: form style, exploded unless the parameter says otherwise. */
const queryEntries = (value: unknown, parameter: Parameter): Array<readonly [string, string]> => {
  if (value === undefined || value === null) return [];
  const style = parameter.style ?? "form";
  const explode = parameter.explode ?? true;
  if (isRecord(value)) {
    const entries = Object.entries(value).filter(
      ([, nested]) => nested !== undefined && nested !== null,
    );
    if (style === "form")
      return explode
        ? entries.map(([name, nested]) => [name, text(nested)])
        : [[parameter.name, entries.flatMap(([name, nested]) => [name, text(nested)]).join(",")]];
    if (style === "deepObject")
      return entries.map(([name, nested]) => [`${parameter.name}[${name}]`, text(nested)]);
    return [[parameter.name, text(value)]];
  }
  if (!Array.isArray(value)) return [[parameter.name, text(value)]];
  if (explode) return value.map((nested) => [parameter.name, text(nested)]);
  const separator = style === "spaceDelimited" ? " " : style === "pipeDelimited" ? "|" : ",";
  return [[parameter.name, value.map(text).join(separator)]];
};

/** v1's request host: the integration's base URL, else the chosen server with its variables. */
const requestHost = (servers: readonly Server[], serverArg: unknown, baseUrl: string) => {
  if (baseUrl !== "") return baseUrl;
  const chosen = isRecord(serverArg)
    ? (servers.find((server) => server.url === serverArg.url) ?? servers[0])
    : servers[0];
  if (chosen === undefined) return "";
  const overrides = isRecord(serverArg) && isRecord(serverArg.variables) ? serverArg.variables : {};
  let url = chosen.url;
  for (const [name, variable] of Object.entries(chosen.variables ?? {})) {
    const override = overrides[name];
    const value =
      override !== undefined && override !== null && override !== ""
        ? String(override)
        : variable.default === undefined
          ? undefined
          : String(variable.default);
    if (value !== undefined) url = url.replaceAll(`{${name}}`, value);
  }
  return url;
};

/** v1 sends Google's `/upload/...` paths from the host root. */
const uploadBase = (baseUrl: string, pathTemplate: string) => {
  if (!pathTemplate.startsWith("/upload/") || !URL.canParse(baseUrl)) return baseUrl;
  const url = new URL(baseUrl);
  const basePath = url.pathname.replace(/\/+$/u, "");
  if (basePath === "" || !pathTemplate.startsWith(`/upload${basePath}/`)) return baseUrl;
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.toString();
};

/** Effect's `prependUrl`: one slash between the base and the path. */
const join = (base: string, path: string) =>
  base.endsWith("/") && path.startsWith("/")
    ? base + path.slice(1)
    : !base.endsWith("/") && !path.startsWith("/")
      ? `${base}/${path}`
      : base + path;

/** v1 replaced an identity whose path names a credential, so no account is named by it. */
const secretKey =
  /(^|[^a-z])(secret|token|password|passwd|apikey|api_key|credential|authorization|auth|session|cookie|private|signature|bearer|refresh)s?([^a-z]|$)/iu;
const keyNamesSecret = (key: string) =>
  secretKey.test(key) || secretKey.test(key.replaceAll(/([a-z0-9])([A-Z])/gu, "$1 $2"));
const index = (segment: string) => /^\d+$/u.test(segment);
const pathNamesSecret = (path: readonly string[]) =>
  keyNamesSecret(path.filter((segment) => !index(segment)).at(-1) ?? "") ||
  path.some(
    (segment, position) =>
      !index(segment) && index(path[position + 1] ?? "") && keyNamesSecret(segment),
  );
const usernameKey =
  /^(login|username|user_name|userName|handle|screen_name|screenName|nickname|slug)$/u;

/**
 * The request v1's OpenAPI check sent, from the declared operation's stored binding. `origins` are
 * the ones the app sends credentials to; a check aimed elsewhere could not carry them. The check
 * adds the credentials itself, so its final URL, after v1's server choice and variables, must be
 * one of those origins, and not over plain HTTP to a public host.
 */
export const openapiHealth = (input: {
  readonly config: OpenApiConfig;
  readonly spec: HealthCheckSpec;
  readonly binding: unknown;
  readonly origins: readonly string[];
}): HealthPlan => {
  if (input.binding === undefined) return none("v1 has no operation named by its check.");
  const decoded = Schema.decodeUnknownOption(Binding)(input.binding);
  if (Option.isNone(decoded)) return none("v1's stored operation for its check could not be read.");
  const binding = decoded.value;
  const method = binding.method.toLowerCase();
  // v1 refused checks that change data, except POST reads.
  if (method === "put" || method === "patch" || method === "delete")
    return none("v1 did not run checks that change data.");
  const args = input.spec.args ?? {};
  const servers = binding.servers ?? [];
  const accepted = new Set<string>();
  for (const parameter of binding.parameters) {
    accepted.add(parameter.name);
    for (const container of containers[parameter.location] ?? []) accepted.add(container);
  }
  for (const match of binding.pathTemplate.matchAll(/\{([^{}]+)\}/gu))
    if (match[1] !== undefined) accepted.add(match[1]);
  if (binding.requestBody !== undefined) {
    accepted.add("body");
    accepted.add("input");
    if ((binding.requestBody.contents?.length ?? 0) > 1) accepted.add("contentType");
  }
  if (
    servers.length > 1 ||
    servers.some((server) => Object.keys(server.variables ?? {}).length > 0)
  )
    accepted.add("server");
  if (Object.keys(args).some((name) => !accepted.has(name)))
    return none("v1's check passed arguments its operation does not take, so it always failed.");

  // The path, as v1's `resolvePath` filled it.
  let path = binding.pathTemplate;
  for (const parameter of binding.parameters) {
    if (parameter.location !== "path") continue;
    const value = parameterValue(args, parameter);
    if (value === undefined || value === null) {
      if (parameter.required === true)
        return none("v1's check left out a required path parameter, so it always failed.");
      continue;
    }
    const encoded = encode(String(value), parameter.allowReserved ?? false);
    path = path
      .replaceAll(`{${parameter.name}}`, encoded)
      .replaceAll(`{+${parameter.name}}`, encoded);
  }
  for (const match of path.matchAll(/\{([^{}]+)\}/gu)) {
    const name = match[1] ?? "";
    const value = args[name];
    if (value !== undefined && value !== null)
      path = path.replaceAll(`{${name}}`, encodeURIComponent(String(value)));
  }
  if (/\{[^{}]+\}/u.test(path))
    return none("v1's check left out a required path parameter, so it always failed.");
  if (!path.startsWith("/")) path = `/${path}`;

  // GitHub refuses requests without a user agent; v1 sent one unless the request named its own.
  const headers: Record<string, string> = { "user-agent": "Executor" };
  const query: Array<readonly [string, string]> = [];
  const cookies: string[] = [];
  for (const parameter of binding.parameters) {
    const value = parameterValue(args, parameter);
    if (parameter.location === "query") query.push(...queryEntries(value, parameter));
    else if (value === undefined || value === null) continue;
    else if (parameter.location === "header") headers[parameter.name] = String(value);
    else if (parameter.location === "cookie") cookies.push(`${parameter.name}=${text(value)}`);
  }
  if (cookies.length > 0) headers.cookie = cookies.join("; ");
  // A pinned value that looks like a credential would be written into the app's source.
  if (
    [...query, ...Object.entries(headers)].some(([name, value]) => credentialLike(name, value)) ||
    cookies.length > 0
  )
    return none("v1's check pins a value that looks like a credential.");

  let body: string | undefined;
  const requestBody = binding.requestBody;
  const bodyValue = args.body ?? args.input;
  if (requestBody !== undefined) {
    if (bodyValue === undefined && requestBody.required === true)
      return none("v1's check left out its operation's required body, so it always failed.");
    if (bodyValue !== undefined) {
      const requested = typeof args.contentType === "string" ? args.contentType : undefined;
      const contentType =
        requestBody.contents?.find((content) => content.contentType === requested)?.contentType ??
        requestBody.contentType;
      const media = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
      if (/(^application\/json$)|(\+json$)/u.test(media)) body = JSON.stringify(bodyValue);
      else if (media === "application/x-www-form-urlencoded" && isRecord(bodyValue))
        body = new URLSearchParams(
          Object.entries(bodyValue).flatMap(([name, value]) =>
            value === undefined || value === null ? [] : [[name, text(value)]],
          ),
        ).toString();
      else if (media.startsWith("text/") && typeof bodyValue === "string") body = bodyValue;
      else return none("v1's check sends a body the importer does not reproduce.");
      headers["content-type"] = contentType;
      if (credentialLike("body", body))
        return none("v1's check pins a value that looks like a credential.");
    }
  }

  const base = uploadBase(
    requestHost(servers, args.server, input.config.baseUrl ?? ""),
    binding.pathTemplate,
  );
  const target = join(base, path);
  if (!URL.canParse(target)) return none("v1's check has no absolute URL.");
  const url = new URL(target);
  if (!input.origins.includes(url.origin))
    return none("v1's check calls another origin than its API.");
  if (plainHttpHosts([url.origin]).length > 0)
    return none("v1's check sends the account's credentials over plain HTTP.");
  // The URL's own query comes first, as it did in v1's request.
  const own = [...url.searchParams.entries()];
  url.search = "";
  const identityPath =
    input.spec.identityField === undefined || input.spec.identityField === ""
      ? undefined
      : input.spec.identityField.split(".");
  const named = identityPath?.filter((segment) => !index(segment)).at(-1) ?? "";
  return {
    ok: true,
    check: {
      kind: "request",
      method: binding.method.toUpperCase(),
      url: url.href,
      query: [...own, ...query],
      headers,
      ...(body === undefined ? {} : { body }),
      ...(identityPath === undefined || pathNamesSecret(identityPath)
        ? {}
        : {
            identity: {
              path: identityPath,
              as: usernameKey.test(named) ? ("username" as const) : ("displayName" as const),
            },
          }),
      description: `${binding.method.toUpperCase()} ${binding.pathTemplate}`,
    },
  };
};

/** v1's introspection query (`packages/plugins/graphql/src/sdk/introspect.ts`), sent as is. */
export const v1IntrospectionQuery = `
  query IntrospectionQuery {
    __schema {
      queryType { name }
      mutationType { name }
      types {
        kind
        name
        description
        fields(includeDeprecated: false) {
          name
          description
          args {
            name
            description
            type {
              ...TypeRef
            }
            defaultValue
          }
          type {
            ...TypeRef
          }
        }
        inputFields {
          name
          description
          type {
            ...TypeRef
          }
          defaultValue
        }
        enumValues(includeDeprecated: false) {
          name
          description
        }
      }
    }
  }

  fragment TypeRef on __Type {
    kind
    name
    ofType {
      kind
      name
      ofType {
        kind
        name
        ofType {
          kind
          name
          ofType {
            kind
            name
            ofType {
              kind
              name
              ofType {
                kind
                name
              }
            }
          }
        }
      }
    }
  }
`;
