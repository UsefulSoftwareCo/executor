/** Compile an OpenAPI document into tool declarations inside the app runtime, never a second execution engine. */
import { Effect, Exit, Option, Schema } from "effect";
import { JsonObject, type JsonValue as Json } from "../contracts/schema.ts";
import { jsonSchema } from "./schema.ts";
import {
  OpenapiErrorResponse,
  OpenapiOperation,
  openapiMediaKind,
  isOpenapiFileSchema,
  isOpenapiJsonSequence,
  isOpenapiTextMedia,
  openapiBinaryResultSchema,
} from "../contracts/openapi.ts";
import {
  substitute as substituteServerVariables,
  test as isServerTemplate,
} from "openapi-server-url-templating";
import {
  OpenapiCompileError as TemplateError,
  type OpenapiSkippedOperation,
} from "../contracts/openapi-compile.ts";
import type { OpenApiImport } from "../contracts/openapi-document.ts";
import {
  Operation,
  Parameter,
  RequestBody,
  Specification,
  type CredentialBinding,
  type GeneratedOperation,
  type GeneratedSecrets,
} from "../contracts/openapi-document.ts";
import {
  decodeDefinition,
  documentObject,
  openApiDocument,
  pointerToken,
  type OpenApiDocument,
} from "./openapi-document.ts";
import { yieldToRuntime } from "./runtime-yield.ts";
import { planOperationNames } from "./openapi-names.ts";

function fail(code: TemplateError["code"], reason: string): never {
  throw new TemplateError({ code, reason });
}
const record = (value: unknown): JsonObject => documentObject(value);
/**
 * An Operation Object without its null fields. YAML writes a field left empty, such as
 * `operationId:`, as null; it means the field is absent, as Executor v1 read it.
 */
const withoutNulls = (operation: JsonObject): JsonObject =>
  Object.values(operation).includes(null)
    ? Object.fromEntries(Object.entries(operation).filter(([, value]) => value !== null))
    : operation;
/** Naming reads only these fields of each declared Operation Object. */
const OperationNaming = Schema.Struct({
  operationId: Schema.optionalKey(Schema.String),
  tags: Schema.optionalKey(Schema.Array(Schema.Unknown)),
});
const isParameterLocation = Schema.is(Parameter.fields.in);
const identifier = (name: string) => name.replace(/[^a-zA-Z0-9_]/g, "_");
/** Parse an absolute URL from the definition. Failures never echo it: a URL can hold credentials. */
function parseUrl(value: string, base?: string): URL {
  try {
    return new URL(value, base);
  } catch {
    return fail(
      "server_url",
      base === undefined && !/^[a-z][a-z0-9+.-]*:/i.test(value)
        ? "The server URL is relative, and an inline definition has no URL to resolve it against. Set baseUrl."
        : "The server URL is not a valid URL. Set baseUrl.",
    );
  }
}
function absolute(value: string): string {
  const url = parseUrl(value);
  if (url.protocol !== "https:" && url.protocol !== "http:")
    fail("server_protocol", `The server uses ${url.protocol}; only HTTP APIs can be imported.`);
  if (url.username || url.password || url.hash || url.search || /[{}]/.test(value))
    fail(
      "server_url",
      "The server URL has credentials, a query, a fragment or unresolved variables. Set baseUrl.",
    );
  return url.href.replace(/\/$/, "");
}
type Server = { readonly url: string; readonly variables?: JsonObject | undefined };
/** Server variables take their defaults, as the request builder fills them. A path- or
 * operation-level server that omits a variable's declaration uses the document server's
 * declaration of the same name. The address keeps only the scheme, host and path.
 */
function serverAddress(server: Server, connectUrl: string | undefined, documentServer?: Server) {
  const variables = { ...documentServer?.variables, ...server.variables };
  const template = isServerTemplate(server.url, { strict: true })
    ? substituteServerVariables(
        server.url,
        Object.fromEntries(
          Object.entries(variables).map(([name, variable]) => {
            const value = Option.getOrUndefined(
              Schema.decodeUnknownOption(JsonObject)(variable),
            )?.default;
            return [name, value === undefined || value === null ? "" : String(value)];
          }),
        ),
        { encoder: (value) => value },
      )
    : server.url;
  let url: URL | undefined;
  try {
    url = new URL(template);
  } catch {
    url = undefined;
  }
  const relative = new URL(template, "https://relative.invalid");
  const base =
    url?.protocol && url.host
      ? `${url.protocol.replace(/\W/g, "")}://${url.host}${url.pathname}`
      : (url?.pathname ??
        (template.startsWith("/") ? relative.pathname : relative.pathname.slice(1)));
  return absolute(parseUrl(`${base.endsWith("/") ? base.slice(0, -1) : base}/`, connectUrl).href);
}
/**
 * Converts one API Schema Object from the document's OpenAPI dialect to Draft 2020-12. `at` is its
 * JSON Pointer in the definition, which failures name.
 */
type ApiSchema = (input: Json, at: string) => JsonObject;
/** Executor-authored Draft 2020-12; never passed through the OpenAPI dialect converter. */
const binaryInput: JsonObject = {
  type: "string",
  description: "File bytes encoded as base64.",
  contentEncoding: "base64",
};
/**
 * A Parameter Object's documentation, which OpenAPI keeps beside its schema rather than in it.
 * It describes this use of the schema, so it replaces the schema's own on the input property;
 * requests never read it. Documentation alone never fails an operation that is otherwise valid.
 */
const parameterDocumentation = (parameter: JsonObject): JsonObject => ({
  ...(typeof parameter.description === "string" && parameter.description.trim() !== ""
    ? { description: parameter.description }
    : {}),
  ...(parameter.deprecated === true ? { deprecated: true } : {}),
});
/**
 * Where a Responses, Request Body or Parameter entry is declared: the object a reference resolved
 * to, or the entry's own place under its operation.
 */
const declaredAt = (document: OpenApiDocument, value: unknown, inline: string) =>
  document.origin(value) ?? inline;
/** The pointer of a media type's schema inside a `content` map declared at `at`. */
const mediaSchemaAt = (document: OpenApiDocument, at: string, type: string, media: unknown) =>
  `${declaredAt(document, media, `${at}/content/${pointerToken(type)}`)}/schema`;
/** An operation's declared responses, as the definition holds them. */
const responsesOf = (operation: JsonObject): JsonObject =>
  operation.responses === undefined ? {} : record(operation.responses);
/** Preserve every documented success shape. Missing schemas remain unknown rather than invented. */
function responseSchema(
  document: OpenApiDocument,
  operation: JsonObject,
  at: string,
  method: string,
): JsonObject | undefined {
  if (method === "HEAD") return { type: "null" };
  const success = Object.entries(responsesOf(operation)).filter(([status]) =>
    /^2(?:[0-9]{2}|XX)$/i.test(status),
  );
  if (success.length === 0) return undefined;
  const shapes: Array<(api: ApiSchema) => JsonObject> = [];
  for (const [status, response] of success) {
    if (status === "204") {
      shapes.push(() => ({ type: "null" }));
      continue;
    }
    const responseAt = declaredAt(document, response, `${at}/responses/${pointerToken(status)}`);
    const content = document.resolve(record(response)).content;
    if (content === undefined) return undefined;
    const media = Object.entries(record(content));
    if (media.length === 0) return undefined;
    for (const [type, body] of media) {
      if (!type.includes("json") || isOpenapiJsonSequence(type)) {
        shapes.push(() =>
          isOpenapiTextMedia(type) ? { type: "string" } : openapiBinaryResultSchema,
        );
        continue;
      }
      const schema = record(body).schema;
      if (schema === undefined) return undefined;
      const schemaAt = mediaSchemaAt(document, responseAt, type, body);
      shapes.push((api) => api(schema, schemaAt));
    }
  }
  return document.schema((api) => ({
    anyOf: shapes.map((shape) => shape(api)),
  }));
}
/** An operation that cannot be resolved is named from its method and path, then skipped. */
function resolvedOrUndefined(document: OpenApiDocument, value: unknown): JsonObject | undefined {
  try {
    return document.resolve(record(value));
  } catch (error) {
    if (!(error instanceof TemplateError) && !Schema.isSchemaError(error)) throw error;
    return undefined;
  }
}
/** Unsupported response references cannot prevent importing otherwise executable calls. */
function errorContent(document: OpenApiDocument, response: JsonObject): Json | undefined {
  try {
    return document.resolve(response).content;
  } catch (error) {
    if (!(error instanceof TemplateError) && !Schema.isSchemaError(error)) throw error;
    return undefined;
  }
}

const isEventStream = (type: string) =>
  type.split(";")[0]?.trim().toLowerCase() === "text/event-stream";
/** Whether a response, resolved or not, offers an event stream. */
const offersEventStream = (document: OpenApiDocument, response: unknown) => {
  const content = errorContent(document, record(response));
  return content !== undefined && Object.keys(record(content)).some(isEventStream);
};
/**
 * An operation that can answer with an event stream or with another media type, such as JSON,
 * without the event stream in its responses, so it asks for and returns the other type, as
 * Executor v1 called it. An operation whose successes offer only an event stream keeps it.
 */
function withoutStreamAlternatives(document: OpenApiDocument, operation: JsonObject): JsonObject {
  if (operation.responses === undefined) return operation;
  const responses = Object.entries(record(operation.responses));
  if (!responses.some(([, response]) => offersEventStream(document, response))) return operation;
  const alternative = responses.some(([status, response]) => {
    if (!/^2(?:[0-9]{2}|XX)$/i.test(status)) return false;
    const content = errorContent(document, record(response));
    return (
      content !== undefined && Object.keys(record(content)).some((type) => !isEventStream(type))
    );
  });
  if (!alternative) return operation;
  return {
    ...operation,
    responses: Object.fromEntries(
      responses.map(([status, response]) => {
        if (!offersEventStream(document, response)) return [status, response];
        const resolved = document.resolve(record(response));
        const content = Object.entries(record(resolved.content)).filter(
          ([type]) => !isEventStream(type),
        );
        return [status, { ...resolved, content: Object.fromEntries(content) }];
      }),
    ),
  };
}

/** Keep tagged errors, including response/component refs and anyOf alternatives.
 * Public text comes from a declared string message or the schema's static description.
 * `scripts/check-api-errors.ts` applies this to Executor's own API documents.
 */
export function errorResponses(
  document: OpenApiDocument,
  operation: JsonObject,
  at: string,
): OpenapiErrorResponse[] {
  const errors: OpenapiErrorResponse[] = [];
  const tagged = Schema.Struct({
    description: Schema.optionalKey(Schema.String),
    required: Schema.Array(Schema.String),
    properties: Schema.Record(Schema.String, JsonObject),
  });
  const visit = (
    status: number,
    input: Json,
    schemaAt: string,
    visited = new Set<string>(),
    parents: readonly { readonly schema: JsonObject; readonly at: string }[] = [],
  ) => {
    const object = Schema.decodeUnknownOption(JsonObject)(input);
    if (Option.isNone(object)) return;
    const value = object.value;
    try {
      if (typeof value.$ref === "string" && visited.has(value.$ref)) return;
      const next = typeof value.$ref === "string" ? new Set([...visited, value.$ref]) : visited;
      const shape = document.resolve(value);
      const shapeAt =
        typeof value.$ref === "string" && value.$ref.startsWith("#/") ? value.$ref : schemaAt;
      const variants = shape.anyOf;
      if (Array.isArray(variants)) {
        // Validate both the selected branch and its parents, including reference siblings.
        for (const [index, variant] of variants.entries())
          visit(status, variant, `${shapeAt}/anyOf/${index}`, next, [
            ...parents,
            { schema: value, at: schemaAt },
          ]);
        return;
      }
      const parsed = Schema.decodeUnknownOption(tagged)(shape);
      if (Option.isNone(parsed) || !parsed.value.required.includes("_tag")) return;
      const tag = parsed.value.properties._tag;
      if (tag === undefined) return;
      const code =
        typeof tag.const === "string"
          ? tag.const
          : Array.isArray(tag.enum) && tag.enum.length === 1
            ? tag.enum[0]
            : undefined;
      const message = parsed.value.properties.message;
      const messageShape = message === undefined ? undefined : document.resolve(message);
      const hasMessage =
        messageShape !== undefined &&
        (messageShape.type === "string" ||
          typeof messageShape.const === "string" ||
          (Array.isArray(messageShape.enum) &&
            messageShape.enum.length > 0 &&
            messageShape.enum.every((value) => typeof value === "string")));
      const declaration = Schema.decodeUnknownOption(OpenapiErrorResponse)({
        code,
        status,
        message: hasMessage
          ? { source: "body" }
          : { source: "schema", value: parsed.value.description },
        schema: document.schema((api) => ({
          allOf: [...parents, { schema: value, at: schemaAt }].map((part) =>
            api(part.schema, part.at),
          ),
        })),
      });
      if (Option.isSome(declaration)) errors.push(declaration.value);
    } catch (error) {
      // Unsupported error declarations must not prevent otherwise supported API calls.
      if (!(error instanceof TemplateError) && !Schema.isSchemaError(error)) throw error;
    }
  };
  for (const [status, response] of Object.entries(responsesOf(operation))) {
    if (!/^[45][0-9]{2}$/.test(status)) continue;
    const content = errorContent(document, record(response));
    if (content === undefined) continue;
    const responseAt = declaredAt(document, response, `${at}/responses/${pointerToken(status)}`);
    for (const [type, body] of Object.entries(record(content))) {
      if (
        !type
          .split(";")[0]
          ?.trim()
          .match(/^application\/(?:[\w.-]+\+)?json$/i)
      )
        continue;
      const schema = record(body).schema;
      if (schema !== undefined)
        visit(Number(status), schema, mediaSchemaAt(document, responseAt, type, body));
    }
  }
  return errors;
}

/** Methods whose operations the importer reads from a Path Item's fixed fields. */
const fixedMethods = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;
/** OpenAPI 3.2 adds the QUERY method as a fixed field. */
const fixedMethods32 = [...fixedMethods, "QUERY"] as const;
const isImportedMethod = Schema.is(OpenapiOperation.fields.method);

/**
 * A path prefix inserted between every operation's server and its path, such as
 * `/projects/{project}`. Each `{name}` becomes a required string path parameter of every
 * operation, unless the operation declares that parameter without using it in its path.
 */
const pathPrefixPattern = /^(?:\/(?:[^/?#{}]|\{[A-Za-z_][\w.-]*\})+)+$/;
function prefixParameters(prefix: string): readonly string[] {
  if (!pathPrefixPattern.test(prefix))
    fail(
      "operation_path",
      "pathPrefix must start with /, have no empty segment, trailing /, ? or #, and write each parameter as {name}.",
    );
  const names = [...prefix.matchAll(/\{([^{}]+)\}/g)].flatMap((match) =>
    match[1] === undefined ? [] : [match[1]],
  );
  if (new Set(names).size !== names.length)
    fail("operation_path", "pathPrefix names the same parameter twice.");
  return names;
}

/**
 * Every operation a definition declares, in definition order, with the tool name it has. Names are
 * planned over every declared operation, so whether the compiler supports one operation never
 * renames another, and a left-out operation keeps the name it would have.
 */
function declaredOperations(document: OpenApiDocument) {
  const { spec } = document;
  // OpenAPI 3.2 adds QUERY and `additionalOperations`, keyed by the exact method to send.
  const version32 = spec.openapi.startsWith("3.2.");
  const candidates = Object.entries(spec.paths).flatMap(([path, source]) => {
    const item = document.resolve(source);
    const itemAt = declaredAt(document, source, `#/paths/${pointerToken(path)}`);
    const additional =
      version32 && item.additionalOperations !== undefined
        ? Object.entries(record(item.additionalOperations)).map(([method, value]) => ({
            method,
            value,
            at: `${itemAt}/additionalOperations/${pointerToken(method)}`,
          }))
        : [];
    const fixed = (version32 ? fixedMethods32 : fixedMethods)
      .filter((method) => item[method.toLowerCase()] !== undefined)
      .map((method): { method: string; value: Json | undefined; at: string } => ({
        method,
        value: item[method.toLowerCase()],
        at: `${itemAt}/${method.toLowerCase()}`,
      }));
    return [...fixed, ...additional].map((operation) => ({ ...operation, path, item, itemAt }));
  });
  return planOperationNames(
    candidates.map((candidate) => {
      const resolved = resolvedOrUndefined(document, candidate.value);
      const naming = Schema.decodeUnknownOption(OperationNaming)(
        resolved === undefined ? undefined : withoutNulls(resolved),
      ).pipe(Option.getOrUndefined);
      return {
        ...candidate,
        operationId: naming?.operationId,
        tag: naming?.tags?.find(
          (tag): tag is string => typeof tag === "string" && tag.trim() !== "",
        ),
      };
    }),
  );
}

/**
 * The tool name, method and declared path of every operation a definition declares, in definition
 * order, whether or not the compiler imports it: the names `compileOpenApiDocument` gives them.
 * The document is consumed, as compilation consumes it.
 */
export const compiledOperationNames = (document: JsonObject) =>
  // oxlint-disable-next-line executor/authored-code-through-adapter -- this module's own parser
  Effect.tryPromise({
    try: async () =>
      declaredOperations(await openApiDocument(document)).map(({ name, method, path }) => ({
        name,
        method,
        path,
      })),
    catch: (error) =>
      error instanceof TemplateError
        ? Exit.fail(error)
        : Schema.isSchemaError(error)
          ? Exit.fail(
              new TemplateError({
                code: "invalid_document",
                reason: "The definition's structure does not match OpenAPI.",
              }),
            )
          : Exit.die(error),
  }).pipe(Effect.catch((exit) => exit));

/** Compile a revision of a live OpenAPI source into tool declarations for the app runtime.
 * The document is consumed: compilation upgrades it in place instead of copying it. It must be a
 * tree, with no object reached twice, as parsed JSON is.
 */
export const compileOpenApiDocument = (
  entry: OpenApiImport,
  inputDocument: JsonObject,
  options: {
    readonly baseUrl?: string;
    /** The origins operations may address; every other operation is left out. */
    readonly allowedOrigin?: string | readonly string[];
    /** Inserted between every operation's server and path; see `prefixParameters`. */
    readonly pathPrefix?: string;
    readonly securitySchemes?: Readonly<Record<string, JsonObject>>;
    readonly fallbackSecurity?: GeneratedOperation["request"]["security"];
  } = {},
) => {
  // The document is consumed once. Holding it only here, and clearing it when compilation takes
  // it, keeps a finished effect from retaining the whole document while its output is written.
  let owned: JsonObject | undefined = inputDocument;
  const take = () => {
    const input = owned;
    owned = undefined;
    if (input === undefined) fail("invalid_document", "This API definition was already compiled.");
    return input;
  };
  // oxlint-disable-next-line executor/authored-code-through-adapter -- this module's own parser
  return Effect.tryPromise({
    try: async () => {
      const document = await openApiDocument(take());
      const { spec } = document;
      const schemes = { ...(options.securitySchemes ?? spec.components?.securitySchemes) };
      const bindings = new Map<string, readonly CredentialBinding[]>();
      const oauth: Array<{
        name: string;
        config:
          | { discover: string }
          | { authorizationUrl: string; tokenUrl: string; scopes: readonly string[] };
      }> = [];
      for (const [name, source] of Object.entries(schemes)) {
        const scheme = document.resolve(source);
        if (
          (scheme.type === "http" && scheme.scheme === "bearer") ||
          (scheme.type === "apiKey" &&
            (scheme.in === "header" || scheme.in === "query" || scheme.in === "cookie") &&
            typeof scheme.name === "string")
        ) {
          bindings.set(name, [
            {
              scheme: name,
              field: "token",
              part: "value",
              prefix: "",
            },
          ]);
        } else if (scheme.type === "http" && scheme.scheme === "basic") {
          bindings.set(name, [
            { scheme: name, field: "username", part: "username", prefix: "" },
            { scheme: name, field: "password", part: "password", prefix: "" },
          ]);
        } else if (scheme.type === "oauth2") {
          const code =
            scheme.flows === undefined ? undefined : record(scheme.flows).authorizationCode;
          if (code !== undefined) {
            const flow = record(code);
            if (typeof flow.authorizationUrl === "string" && typeof flow.tokenUrl === "string")
              oauth.push({
                name,
                config:
                  entry.oauthDiscoveryUrl === undefined
                    ? {
                        authorizationUrl: absolute(
                          parseUrl(flow.authorizationUrl, entry.connectUrl).href,
                        ),
                        tokenUrl: absolute(parseUrl(flow.tokenUrl, entry.connectUrl).href),
                        scopes: [
                          ...(entry.scopes ?? Object.keys(record(flow.scopes ?? {}))),
                        ].sort(),
                      }
                    : { discover: absolute(entry.oauthDiscoveryUrl) },
              });
          }
        }
      }
      let fallback = options.fallbackSecurity;
      if (
        bindings.size === 0 &&
        Object.keys(schemes).length === 0 &&
        entry.auth?.header !== undefined
      ) {
        const header = /^([!#$%&'*+.^_`|~A-Za-z0-9-]+):\s*([^{}\r\n]*)\{[A-Za-z0-9_]+\}$/.exec(
          entry.auth.header,
        );
        if (!header?.[1] || header[2] === undefined)
          fail("auth_helper", "This catalog entry needs a custom authentication helper.");
        bindings.set("apiKey", [
          {
            scheme: "apiKey",
            field: "token",
            part: "value",
            prefix: header[2],
          },
        ]);
        schemes.apiKey = { type: "apiKey", in: "header", name: header[1] };
        fallback = [{ apiKey: [] }];
      }
      if (
        !fallback &&
        !Object.keys(schemes).length &&
        entry.auth &&
        !["none", "public"].includes(entry.auth.kind)
      )
        fail(
          "auth_missing",
          "This entry does not declare enough authentication details to generate an app.",
        );
      const methods = new Map<string, GeneratedSecrets>();
      // An operation the importer cannot represent is left out, not fatal. Each is recorded with
      // its reason, which a failure to import any operation reports.
      const skipped: OpenapiSkippedOperation[] = [];
      const built: {
        operation: GeneratedOperation;
        methods: GeneratedSecrets[];
        declared: { name: string; method: string; path: string };
      }[] = [];
      const documentServer = spec.servers?.[0];
      const prefix = options.pathPrefix === undefined ? [] : prefixParameters(options.pathPrefix);
      // Operations mostly share a server, so each distinct one is worked out once, errors included.
      const addresses = new Map<
        string,
        { readonly address: string } | { readonly error: unknown }
      >();
      const addressOf = (server: Server) => {
        const key = JSON.stringify([server, documentServer?.variables ?? null]);
        let known = addresses.get(key);
        if (known === undefined) {
          try {
            known = { address: serverAddress(server, entry.connectUrl, documentServer) };
          } catch (error) {
            known = { error };
          }
          addresses.set(key, known);
        }
        if ("error" in known) throw known.error;
        return known.address;
      };
      const named = declaredOperations(document);
      if (!named.length) fail("no_operations", "This API does not contain any operations.");
      // Left-out operations are reported in definition order, whatever stage left them out.
      const order = new Map(named.map(({ name }, index) => [name, index]));
      const inDefinitionOrder = (operations: readonly OpenapiSkippedOperation[]) =>
        [...operations].sort((a, b) => (order.get(a.name) ?? 0) - (order.get(b.name) ?? 0));
      for (const [index, { name, path, item, itemAt, method, value, at }] of named.entries()) {
        if (index % 100 === 99) await yieldToRuntime();
        try {
          if (!path.startsWith("/")) fail("operation_path", "The path must start with /.");
          if (!isImportedMethod(method))
            fail(
              "operation_method",
              `The HTTP method ${method} is not sent. Only ${fixedMethods32.join(", ")} operations are imported.`,
            );
          const operationMethods: GeneratedSecrets[] = [];
          const resolved = withoutStreamAlternatives(
            document,
            withoutNulls(document.resolve(record(value))),
          );
          const operation = decodeDefinition(Operation, resolved, at, "operation");
          // Tags only label the tool; a malformed list is dropped rather than rejecting it.
          const tags = Option.getOrUndefined(
            Schema.decodeUnknownOption(Schema.Array(Schema.NonEmptyString))(resolved.tags),
          );
          // Planning refines every collision; only a hash collision can repeat a name.
          if (built.some((op) => op.operation.name === name))
            fail(
              "duplicate_operation",
              `Another operation has the same tool name, ${name}. Give one of them a distinct operationId.`,
            );
          const serverList =
            operation.servers ??
            (Array.isArray(item.servers)
              ? decodeDefinition(
                  Specification.fields.servers,
                  item.servers,
                  `${itemAt}/servers`,
                  "servers",
                )
              : undefined) ??
            spec.servers;
          const server = serverList?.[0];
          const serverUrl = options.baseUrl ?? server?.url;
          if (serverUrl === undefined)
            fail(
              "server_missing",
              "The definition declares no server for this operation. Set baseUrl.",
            );
          const baseUrl = addressOf(
            options.baseUrl === undefined && server !== undefined ? server : { url: serverUrl },
          );
          // Path Item parameters apply to every operation; an operation's own replace them.
          const declared = [
            ...(Array.isArray(item.parameters) ? item.parameters : []).map(
              (parameter, position) => ({
                parameter,
                at: declaredAt(document, parameter, `${itemAt}/parameters/${position}`),
              }),
            ),
            ...(Array.isArray(resolved.parameters) ? resolved.parameters : []).map(
              (parameter, position) => ({
                parameter,
                at: declaredAt(document, parameter, `${at}/parameters/${position}`),
              }),
            ),
          ];
          const parameters = new Map<
            string,
            { parameter: Parameter; documentation: JsonObject; at: string | undefined }
          >();
          for (const { parameter, at: parameterAt } of declared) {
            const declaration = document.resolve(record(parameter));
            // A parameter in a place OpenAPI 3 does not have, such as Swagger 2.0's `body`, is not
            // sent, as Executor v1 left it out.
            if (!isParameterLocation(declaration.in)) continue;
            const p = decodeDefinition(Parameter, declaration, parameterAt, "parameter");
            if (p.in === "querystring") {
              const [media, ...others] = Object.keys(p.content ?? {});
              const kind =
                media === undefined || others.length > 0 ? undefined : openapiMediaKind(media);
              if (kind !== "form" && kind !== "json" && kind !== "text")
                fail(
                  "parameter_encoding",
                  `The querystring parameter at ${parameterAt} must declare one form, JSON or text media type in content.`,
                );
            }
            parameters.set(`${p.in}:${p.name}`, {
              parameter: p,
              documentation: parameterDocumentation(declaration),
              at: parameterAt,
            });
          }
          // A path prefix parameter the operation declares without placing it keeps its schema.
          for (const name of prefix) {
            const key = `path:${name}`;
            if (path.includes(`{${name}}`))
              fail(
                "operation_path",
                `pathPrefix adds the path parameter {${name}}, which this operation's path already uses.`,
              );
            if (!parameters.has(key))
              parameters.set(key, {
                parameter: { name, in: "path", required: true, schema: { type: "string" } },
                documentation: {},
                at: undefined,
              });
          }
          // Parameter schemas stay in the API dialect until the input schema is composed.
          const groups = new Map<
            string,
            { properties: Record<string, (api: ApiSchema) => Json>; required: string[] }
          >();
          for (const { parameter: p, documentation, at: parameterAt } of parameters.values()) {
            const key = p.in === "header" ? "headers" : p.in;
            const group = groups.get(key) ?? { properties: {}, required: [] };
            const [mediaType, content] =
              p.content === undefined ? [] : (Object.entries(p.content)[0] ?? []);
            const schema =
              p.schema ?? (content === undefined ? {} : (record(content).schema ?? {}));
            const schemaAt =
              p.schema !== undefined || mediaType === undefined
                ? `${parameterAt}/schema`
                : mediaSchemaAt(document, `${parameterAt}`, mediaType, content);
            // A parameter that only the path prefix declares is Executor's own Draft 2020-12.
            group.properties[p.name] =
              parameterAt === undefined
                ? () => schema
                : (api) => ({ ...api(schema, schemaAt), ...documentation });
            if (p.required || p.in === "path") group.required.push(p.name);
            groups.set(key, group);
          }
          const properties: Record<string, (api: ApiSchema) => Json> = {};
          const required: string[] = [];
          for (const [key, group] of groups) {
            properties[key] = (api) => ({
              type: "object",
              properties: Object.fromEntries(
                Object.entries(group.properties).map(([name, schema]) => [name, schema(api)]),
              ),
              required: group.required,
              additionalProperties: false,
            });
            if (group.required.length) required.push(key);
          }
          const bodyVariants: Array<(api: ApiSchema) => JsonObject> = [];
          let retainedBody: GeneratedOperation["request"]["requestBody"];
          const bodyAt = declaredAt(document, resolved.requestBody, `${at}/requestBody`);
          const request =
            operation.requestBody === undefined
              ? undefined
              : decodeDefinition(
                  RequestBody,
                  document.resolve(operation.requestBody),
                  bodyAt,
                  "request body",
                );
          // A request body that declares no media types has nothing to send, as Executor v1 read it.
          if (request !== undefined && Object.keys(request.content).length > 0) {
            const rawContent = record(document.resolve(record(resolved.requestBody)).content);
            const retainedContent: Record<string, (typeof RequestBody.Type.content)[string]> = {};
            for (const [contentType, content] of Object.entries(request.content)) {
              const kind = openapiMediaKind(contentType);
              const schema = document.resolve(content.schema ?? {});
              const declared = content.schema ?? {};
              const schemaAt = mediaSchemaAt(
                document,
                bodyAt,
                contentType,
                rawContent[contentType],
              );
              // The converted input already holds the body schema. Retain only the resolved
              // multipart file shapes the runtime needs for base64 conversion.
              const retainedFiles: Record<string, JsonObject> = {};
              let inputSchema: (api: ApiSchema) => JsonObject =
                kind === "binary"
                  ? () => binaryInput
                  : kind === "text"
                    ? () => ({ type: "string" })
                    : (api) => api(declared, schemaAt);
              if (kind === "multipart") {
                const fields = { ...record(schema.properties ?? {}) };
                const files: Record<string, JsonObject> = {};
                for (const [key, field] of Object.entries(fields)) {
                  const shape = document.resolve(record(field));
                  if (isOpenapiFileSchema(shape)) {
                    delete fields[key];
                    files[key] = binaryInput;
                    retainedFiles[key] = shape;
                  }
                }
                const form = schema;
                const formAt = typeof declared.$ref === "string" ? declared.$ref : schemaAt;
                // File fields take base64 input; the remaining form keeps its API constraints.
                inputSchema = (api) => {
                  const converted = api({ ...form, properties: fields }, formAt);
                  return {
                    ...converted,
                    properties: { ...record(converted.properties ?? {}), ...files },
                  };
                };
              }
              retainedContent[contentType] = {
                ...(content.encoding === undefined ? {} : { encoding: content.encoding }),
                ...(Object.keys(retainedFiles).length
                  ? { schema: { type: "object", properties: retainedFiles } }
                  : {}),
              };
              const first = bodyVariants.length === 0;
              bodyVariants.push((api) => ({
                properties: { contentType: { enum: [contentType] }, body: inputSchema(api) },
                ...(first ? {} : { required: ["contentType"] }),
              }));
            }
            retainedBody = { ...request, content: retainedContent };
            properties.body = () => ({});
            properties.contentType = () => ({
              type: "string",
              enum: Object.keys(request.content),
              description: "Request media type. Defaults to the first declared type.",
            });
            if (request.required) required.push("body");
          }
          const requirements = operation.security ?? spec.security ?? fallback ?? [];
          // An alternative naming a scheme securitySchemes does not declare can never be met. It is
          // ignored, so it neither hides another alternative nor reaches the request. When every
          // alternative is ignored, the operation is left out rather than made public.
          const security = requirements.filter((requirement) =>
            Object.keys(requirement).every((key) => Object.hasOwn(schemes, key)),
          );
          if (security.length === 0 && requirements.length > 0) {
            const undeclared = [
              ...new Set(
                requirements.flatMap(Object.keys).filter((key) => !Object.hasOwn(schemes, key)),
              ),
            ];
            fail(
              "auth_method",
              `Every security requirement names a scheme securitySchemes does not declare: ${undeclared.map((key) => JSON.stringify(key)).join(", ")}. Declare and fill every scheme in one complete alternative (securitySchemes plus methods or oauth).`,
            );
          }
          for (const requirement of security) {
            const keys = Object.keys(requirement).sort();
            if (!keys.length) continue;
            // Each selected account supplies one complete supported alternative.
            // Unsupported alternatives do not hide a usable key or public alternative.
            if (!keys.every((key) => bindings.has(key))) continue;
            const parts = keys.flatMap((key) => bindings.get(key) ?? []);
            const methodName =
              bindings.size === 1 && keys.length === 1 ? "apiKey" : keys.join("_and_");
            operationMethods.push({
              name: methodName,
              label: parts.length === 1 ? "API key" : keys.join(" + "),
              bindings: parts.map((part) => ({
                ...part,
                field: keys.length === 1 ? part.field : `${identifier(part.scheme)}_${part.field}`,
              })),
            });
          }
          const input = document.schema((api) => ({
            type: "object",
            properties: Object.fromEntries(
              Object.entries(properties).map(([key, shape]) => [key, shape(api)]),
            ),
            required,
            ...(bodyVariants.length ? { anyOf: bodyVariants.map((variant) => variant(api)) } : {}),
            additionalProperties: false,
          }));
          try {
            jsonSchema(input);
          } catch {
            fail("input_schema", "Its input schema is not valid JSON.");
          }
          const outputSchema = responseSchema(document, resolved, at, method);
          // Only an operation without another success type is left with an event stream.
          const streaming = Object.values(operation.responses ?? {}).some((response) =>
            offersEventStream(document, response),
          );
          built.push({
            methods: operationMethods,
            declared: { name, method, path },
            operation: {
              ...(streaming ? { streaming: true as const } : {}),
              ...(tags === undefined || tags.length === 0 ? {} : { tags }),
              name,
              ...(operation.operationId === undefined
                ? {}
                : { operationId: operation.operationId }),
              description: operation.summary ?? operation.description ?? name,
              method,
              path: `${options.pathPrefix ?? ""}${path}`,
              baseUrl,
              openapi: spec.openapi,
              securitySchemes: Object.fromEntries(
                Object.entries(schemes).filter(([key]) =>
                  security.some((requirement) => Object.hasOwn(requirement, key)),
                ),
              ),
              request: {
                parameters: [...parameters.values()].map(({ parameter }) => parameter),
                ...(retainedBody === undefined ? {} : { requestBody: retainedBody }),
                security,
                responses: Object.fromEntries(
                  Object.entries(operation.responses ?? {}).flatMap(([status, response]) => {
                    const content = errorContent(document, response);
                    return content === undefined
                      ? []
                      : [
                          [
                            status,
                            {
                              content: Object.fromEntries(
                                Object.keys(record(content)).map((type) => [type, {}]),
                              ),
                            },
                          ],
                        ];
                  }),
                ),
              },
              input,
              ...(outputSchema === undefined ? {} : { outputSchema }),
              errorResponses: errorResponses(document, resolved, at),
            },
          });
        } catch (error) {
          if (!(error instanceof TemplateError) && !Schema.isSchemaError(error)) throw error;
          skipped.push({
            name,
            method,
            path,
            ...(error instanceof TemplateError
              ? { code: error.code, reason: error.reason }
              : {
                  code: "invalid_document" as const,
                  reason: `The operation at ${at} does not match OpenAPI.`,
                }),
          });
        }
      }
      // Every credential-bearing operation of one app addresses an origin the app allows, so an
      // account's key never reaches a host it did not choose. Without `allowedOrigin`, the origin
      // most operations use is pinned; on a tie the document server's origin wins, then the first
      // origin seen. A document server that every operation overrides is never called, so it
      // cannot outvote them.
      const counts = new Map<string, number>();
      for (const { operation } of built) {
        const origin = new URL(operation.baseUrl).origin;
        counts.set(origin, (counts.get(origin) ?? 0) + 1);
      }
      let documentOrigin: string | undefined;
      try {
        if (documentServer !== undefined)
          documentOrigin = new URL(serverAddress(documentServer, entry.connectUrl)).origin;
      } catch (error) {
        if (!(error instanceof TemplateError)) throw error;
      }
      const allowed =
        options.allowedOrigin === undefined
          ? undefined
          : typeof options.allowedOrigin === "string"
            ? [options.allowedOrigin]
            : options.allowedOrigin;
      let mostUsed: string | undefined;
      for (const [origin, count] of allowed === undefined ? counts : []) {
        const best = mostUsed === undefined ? 0 : (counts.get(mostUsed) ?? 0);
        if (count > best || (count === best && origin === documentOrigin)) mostUsed = origin;
      }
      const pinnedOrigins = new Set(allowed ?? (mostUsed === undefined ? [] : [mostUsed]));
      // Operations on a pinned origin, each with its declaration.
      const imported: {
        operation: GeneratedOperation;
        declared: (typeof built)[number]["declared"];
      }[] = [];
      for (const { operation, methods: operationMethods, declared } of built) {
        const origin = new URL(operation.baseUrl).origin;
        if (!pinnedOrigins.has(origin)) {
          skipped.push({
            ...declared,
            code: "multiple_hosts",
            reason:
              allowed === undefined
                ? `Its server origin ${origin} differs from ${mostUsed ?? "the origin"} most operations use.`
                : `Its server origin ${origin} is not allowedOrigin ${allowed.join(", ")}.`,
          });
          continue;
        }
        imported.push({ operation, declared });
        for (const method of operationMethods) methods.set(method.name, method);
      }
      const operations = imported.map(({ operation }) => operation);
      if (!operations.length) {
        const left = inDefinitionOrder(skipped);
        // When the allowed origin is no operation's, say which origins the operations use.
        if (allowed !== undefined && built.length > 0)
          throw new TemplateError({
            code: "no_supported_operations",
            reason: `allowedOrigin ${allowed.join(", ")} is not the origin of any operation. They resolve to ${[...counts.keys()].join(", ")}. Set allowedOrigin to the origin that receives the account's credentials, or set baseUrl.`,
            skipped: left,
            origins: [...counts.keys()],
          });
        // One shared cause, such as a missing server URL, keeps its own explanation.
        const [first] = left;
        if (
          first !== undefined &&
          left.every(({ code, reason }) => code === first.code && reason === first.reason)
        )
          throw new TemplateError({ code: first.code, reason: first.reason, skipped: left });
        throw new TemplateError({
          code: "no_supported_operations",
          reason: "No operation in this API definition can be imported.",
          skipped: left,
        });
      }
      // An imported operation no account can call: it streams, or every security requirement
      // needs a scheme Executor cannot authenticate with. When that is every operation, each one's
      // reason is reported with the operations left out.
      const supported = (requirement: Readonly<Record<string, unknown>>) => {
        const keys = Object.keys(requirement);
        return (
          keys.every((key) => bindings.has(key)) ||
          (keys.length === 1 && oauth.some((method) => method.name === keys[0]))
        );
      };
      const schemeLabel = (key: string) => {
        const scheme = document.resolve(record(schemes[key]));
        const detail =
          scheme.type === "oauth2"
            ? Object.keys(record(scheme.flows ?? {})).join("/")
            : scheme.type === "http"
              ? scheme.scheme
              : scheme.type === "apiKey"
                ? `in ${String(scheme.in)}`
                : undefined;
        return `${key} (${[scheme.type, detail].filter((part) => typeof part === "string" && part !== "").join(" ")})`;
      };
      const unsupportedBy = (requirement: Readonly<Record<string, unknown>>) => {
        const keys = Object.keys(requirement);
        const unknown = keys.filter(
          (key) => !bindings.has(key) && !oauth.some((method) => method.name === key),
        );
        return unknown.length > 0
          ? unknown.map(schemeLabel).join(" and ")
          : `${keys.map(schemeLabel).join(" with ")}, which combines OAuth sign-in with another scheme`;
      };
      /** Why no account can call an imported operation, or undefined when one can. */
      const unusable = (
        operation: GeneratedOperation,
      ): Pick<OpenapiSkippedOperation, "code" | "reason"> | undefined => {
        const { security } = operation.request;
        if (operation.streaming === true)
          return {
            code: "event_stream",
            reason:
              "It responds with text/event-stream, which a tool cannot return. Write a subscription for it.",
          };
        if (security.length === 0 || security.some(supported)) return undefined;
        return {
          code: "auth_method",
          reason: `None of its security requirements can be used to authenticate: ${security.map(unsupportedBy).join("; ")}.`,
        };
      };
      if (imported.every(({ operation }) => unusable(operation) !== undefined))
        throw new TemplateError({
          code: "no_supported_operations",
          reason:
            "No operation can be called: each one is left out, streams its response, or needs authentication that is not supported.",
          skipped: inDefinitionOrder([
            ...skipped,
            ...imported.flatMap(({ operation, declared }) => {
              const cause = unusable(operation);
              return cause === undefined ? [] : [{ ...declared, ...cause }];
            }),
          ]),
        });
      return {
        operations,
        /** Declared operations left out of `operations`, in definition order. */
        skipped: inDefinitionOrder(skipped),
        definitions: Object.fromEntries(document.definitions),
        methods: Object.fromEntries(
          [...methods.values()].map((method) => [method.name, method.bindings]),
        ),
        secrets: [...methods.values()],
        oauth,
        schemes,
        pinnedOrigins: [...pinnedOrigins],
        fallback,
      };
    },
    // Expected failures stay typed; anything else is a defect in the importer, not the definition.
    catch: (error) =>
      error instanceof TemplateError
        ? Exit.fail(error)
        : Schema.isSchemaError(error)
          ? Exit.fail(
              new TemplateError({
                code: "invalid_document",
                reason: "The definition's structure does not match OpenAPI.",
              }),
            )
          : Exit.die(error),
  }).pipe(Effect.catch((exit) => exit));
};
