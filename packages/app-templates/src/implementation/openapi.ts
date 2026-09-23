/** Compile an API document into ordinary app source, never a second execution engine. */
import { Effect, Schema } from "effect";
import { JsonObject, SourceFiles, type Json } from "@executor-js/sdk";
import { jsonSchema } from "apps";
import { TemplateError } from "../contracts/templates.ts";
import type { OpenApiImport } from "../contracts/openapi.ts";
import {
  Operation,
  Parameter,
  RequestBody,
  Specification,
  type CredentialBinding,
  type GeneratedOperation,
  type GeneratedSecrets,
} from "../contracts/openapi.ts";
import { packageFile, sourceFiles } from "./files.ts";

function fail(code: TemplateError["code"], reason: string): never {
  throw new TemplateError({ code, reason });
}
const record = (value: unknown): JsonObject => Schema.decodeUnknownSync(JsonObject)(value);
const own = (value: JsonObject, key: string): Json | undefined =>
  Object.hasOwn(value, key) ? value[key] : undefined;
const serialize = (value: unknown) => JSON.stringify(value, null, 2);
const identifier = (name: string) => name.replace(/[^a-zA-Z0-9_]/g, "_");
function absolute(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:")
    fail("server_protocol", "Only HTTP APIs can be imported.");
  if (url.username || url.password || url.hash || url.search || /[{}]/.test(value))
    fail("server_url", "This API needs a configured server URL before import.");
  return url.href.replace(/\/$/, "");
}
function resolve(root: JsonObject, value: JsonObject, visited = new Set<string>()): JsonObject {
  const ref = value.$ref;
  if (ref === undefined) return value;
  if (typeof ref !== "string" || !ref.startsWith("#/"))
    fail("external_reference", "External OpenAPI references are not supported yet.");
  if (visited.has(ref))
    fail("circular_reference", "A circular OpenAPI object reference cannot be imported.");
  let found: unknown = root;
  for (const part of ref.slice(2).split("/"))
    found = own(record(found), part.replace(/~1/g, "/").replace(/~0/g, "~"));
  return resolve(root, record(found), new Set([...visited, ref]));
}
/** Preserve every documented success shape. Missing schemas remain unknown rather than invented. */
function responseSchema(
  root: JsonObject,
  operation: Operation,
  method: string,
  schemas: Readonly<Record<string, JsonObject>>,
): JsonObject | undefined {
  if (method === "HEAD") return { type: "null" };
  const success = Object.entries(operation.responses ?? {}).filter(([status]) =>
    /^2(?:[0-9]{2}|XX)$/i.test(status),
  );
  if (success.length === 0) return undefined;
  const shapes: JsonObject[] = [];
  for (const [status, response] of success) {
    if (status === "204") {
      shapes.push({ type: "null" });
      continue;
    }
    const content = resolve(root, response).content;
    if (content === undefined) return undefined;
    const media = Object.entries(record(content));
    if (media.length === 0) return undefined;
    for (const [type, body] of media) {
      if (!type.includes("json")) {
        shapes.push({ type: "string" });
        continue;
      }
      const schema = record(body).schema;
      if (schema === undefined) return undefined;
      shapes.push(record(schema));
    }
  }
  return schemaDocument({ anyOf: shapes }, schemas);
}
function schemaDocument(
  input: JsonObject,
  schemas: Readonly<Record<string, JsonObject>>,
): JsonObject {
  const definitions = new Map<string, JsonObject>();
  const convert = (value: Json): Json => {
    if (typeof value === "boolean") return value;
    const output: Record<string, Json> = { ...record(value) };
    for (const key of ["properties", "patternProperties", "$defs", "dependentSchemas"]) {
      if (output[key] !== undefined)
        output[key] = Object.fromEntries(
          Object.entries(record(output[key])).map(([name, schema]) => [name, convert(schema)]),
        );
    }
    for (const key of ["allOf", "anyOf", "oneOf", "prefixItems"]) {
      const items = output[key];
      if (items !== undefined) {
        if (!Array.isArray(items))
          fail("schema_keyword", "An API schema keyword has an invalid value.");
        output[key] = items.map(convert);
      }
    }
    for (const key of [
      "items",
      "additionalProperties",
      "unevaluatedProperties",
      "not",
      "if",
      "then",
      "else",
      "contains",
      "propertyNames",
    ]) {
      if (output[key] !== undefined) output[key] = convert(output[key]);
    }
    if (typeof output.$ref === "string") {
      const match = /^#\/components\/schemas\/([^/]+)$/.exec(output.$ref);
      if (!match?.[1])
        fail("schema_reference", "Only local component schema references are supported.");
      const name = match[1].replace(/~1/g, "/").replace(/~0/g, "~");
      const definition = schemas[name];
      if (definition === undefined)
        fail("missing_component", "An input schema references a missing component.");
      output.$ref = `#/$defs/${match[1]}`;
      if (!definitions.has(name)) {
        definitions.set(name, {});
        definitions.set(name, record(convert(definition)));
      }
    }
    if (output.nullable === true) {
      delete output.nullable;
      return { anyOf: [output, { type: "null" }] };
    }
    delete output.nullable;
    if (typeof output.exclusiveMinimum === "boolean") {
      if (output.exclusiveMinimum && typeof output.minimum === "number") {
        output.exclusiveMinimum = output.minimum;
        delete output.minimum;
      } else delete output.exclusiveMinimum;
    }
    if (typeof output.exclusiveMaximum === "boolean") {
      if (output.exclusiveMaximum && typeof output.maximum === "number") {
        output.exclusiveMaximum = output.maximum;
        delete output.maximum;
      } else delete output.exclusiveMaximum;
    }
    // OpenAPI formats describe wire representations, not additional JSON validation.
    if (output.format === "binary" || output.format === "byte") delete output.format;
    return output;
  };
  const converted = record(convert(input));
  return {
    ...converted,
    $defs: Object.fromEntries(definitions),
    $schema: "https://json-schema.org/draft/2020-12/schema",
  };
}
/** Parse and generate once at import; API calls only use retained source and selected account fields. */
const generateDefinition = (
  entry: OpenApiImport,
  document: unknown,
  options: { readonly baseUrl?: string } = {},
) =>
  Effect.try({
    try: () => {
      const root = record(document);
      const spec = Schema.decodeUnknownSync(Specification)(root);
      if (!/^3\.[01]\./.test(spec.openapi))
        fail(
          "openapi_version",
          "This importer supports OpenAPI 3.0 and 3.1. Swagger 2 needs conversion first.",
        );
      const schemes = spec.components?.securitySchemes ?? {};
      const bindings = new Map<string, CredentialBinding>();
      const cookieSchemes = new Set<string>();
      const oauth: Array<{ name: string; declaration: string }> = [];
      for (const [name, source] of Object.entries(schemes)) {
        const scheme = resolve(root, source);
        if (scheme.type === "http" && scheme.scheme === "bearer") {
          bindings.set(name, {
            scheme: name,
            field: "token",
            in: "header",
            name: "Authorization",
            prefix: "Bearer ",
          });
        } else if (
          scheme.type === "apiKey" &&
          (scheme.in === "header" || scheme.in === "query") &&
          typeof scheme.name === "string"
        ) {
          bindings.set(name, {
            scheme: name,
            field: "token",
            in: scheme.in,
            name: scheme.name,
            prefix: "",
          });
        } else if (
          scheme.type === "apiKey" &&
          scheme.in === "cookie" &&
          typeof scheme.name === "string"
        ) {
          // Retain cookie security requirements; the tool helper has no cookie credential binding.
          cookieSchemes.add(name);
        } else if (scheme.type === "oauth2") {
          const code = record(scheme.flows).authorizationCode;
          if (code !== undefined) {
            const flow = record(code);
            if (typeof flow.authorizationUrl === "string" && typeof flow.tokenUrl === "string")
              oauth.push({
                name,
                declaration: `oauth2(${serialize(
                  entry.oauthDiscoveryUrl === undefined
                    ? {
                        authorizationUrl: absolute(
                          new URL(flow.authorizationUrl, entry.connectUrl).href,
                        ),
                        tokenUrl: absolute(new URL(flow.tokenUrl, entry.connectUrl).href),
                        scopes: [
                          ...(entry.scopes ?? Object.keys(record(flow.scopes ?? {}))),
                        ].sort(),
                      }
                    : { discover: absolute(entry.oauthDiscoveryUrl) },
                )})`,
              });
          }
        }
      }
      let fallback: readonly (readonly string[])[] | undefined;
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
        bindings.set("apiKey", {
          scheme: "apiKey",
          field: "token",
          in: "header",
          name: header[1],
          prefix: header[2],
        });
        fallback = [["apiKey"]];
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
      const operations: GeneratedOperation[] = [];
      // Every credential-bearing operation of one app addresses one origin. A document-,
      // path- or operation-level `servers` override that names another host would send the
      // connected account's key there, so the first resolved origin pins the rest.
      const rootServer = options.baseUrl ?? spec.servers?.[0]?.url;
      let pinnedOrigin =
        rootServer === undefined
          ? undefined
          : new URL(absolute(new URL(rootServer, entry.connectUrl).href)).origin;
      for (const [path, source] of Object.entries(spec.paths)) {
        if (!path.startsWith("/") || path.includes("?") || path.includes("#"))
          fail("operation_path", "An operation has an invalid API path.");
        const item = resolve(root, source);
        for (const method of [
          "GET",
          "POST",
          "PUT",
          "PATCH",
          "DELETE",
          "HEAD",
          "OPTIONS",
        ] as const) {
          if (item[method.toLowerCase()] === undefined) continue;
          const operation = Schema.decodeUnknownSync(Operation)(
            resolve(root, record(item[method.toLowerCase()])),
          );
          const name = identifier(operation.operationId ?? `${method.toLowerCase()}_${path}`);
          if (operations.some((op) => op.name === name))
            fail(
              "duplicate_operation",
              "The API has duplicate tool names. Update its operation IDs first.",
            );
          const serverList =
            operation.servers ??
            (Array.isArray(item.servers)
              ? Schema.decodeUnknownSync(Specification.fields.servers)(item.servers)
              : undefined) ??
            spec.servers;
          const server = serverList?.[0];
          const serverUrl = options.baseUrl ?? server?.url;
          if (serverUrl === undefined)
            fail("server_missing", "The API has no server URL. Set an API base URL and try again.");
          const baseUrl = absolute(new URL(serverUrl, entry.connectUrl).href);
          pinnedOrigin ??= new URL(baseUrl).origin;
          if (new URL(baseUrl).origin !== pinnedOrigin)
            fail(
              "multiple_hosts",
              "This API sends some operations to a different host. Set an API base URL first.",
            );
          const combined = [
            ...(Array.isArray(item.parameters) ? item.parameters : []),
            ...(operation.parameters ?? []),
          ];
          const parameters = new Map<string, Parameter>();
          for (const parameter of combined) {
            const p = Schema.decodeUnknownSync(Parameter)(resolve(root, record(parameter)));
            parameters.set(`${p.in}:${p.name}`, p);
          }
          const groups = new Map<
            string,
            { properties: Record<string, Json>; required: string[] }
          >();
          const requestParameters: GeneratedOperation["parameters"][number][] = [];
          for (const p of parameters.values()) {
            if (p.in === "cookie" || p.content !== undefined || p.allowReserved)
              fail("parameter_encoding", `Tool ${name} uses unsupported parameter encoding.`);
            const style = p.style ?? (p.in === "query" ? "form" : "simple");
            if (
              (p.in === "query" &&
                !["form", "spaceDelimited", "pipeDelimited", "deepObject"].includes(style)) ||
              (p.in !== "query" && style !== "simple")
            )
              fail("parameter_style", `Tool ${name} uses unsupported parameter style.`);
            const key = p.in === "header" ? "headers" : p.in;
            const group = groups.get(key) ?? { properties: {}, required: [] };
            group.properties[p.name] = p.schema ?? {};
            if (p.required || p.in === "path") group.required.push(p.name);
            groups.set(key, group);
            requestParameters.push({
              name: p.name,
              in: p.in,
              style,
              explode: p.explode ?? style === "form",
            });
          }
          const properties: Record<string, Json> = {};
          const required: string[] = [];
          for (const [key, group] of groups) {
            properties[key] = { type: "object", ...group, additionalProperties: false };
            if (group.required.length) required.push(key);
          }
          let body: GeneratedOperation["body"] = "none";
          if (operation.requestBody) {
            const request = Schema.decodeUnknownSync(RequestBody)(
              resolve(root, operation.requestBody),
            );
            if (request.content["application/json"]) {
              body = "json";
              properties.body = request.content["application/json"].schema ?? {};
            } else if (request.content["application/octet-stream"]) {
              body = "base64";
              properties.body = { type: "string", description: "File bytes encoded as base64." };
            } else
              fail(
                "request_body",
                `Tool ${name} uses an unsupported request body. JSON and binary files are supported.`,
              );
            if (request.required) required.push("body");
          }
          const security =
            operation.security === undefined && spec.security === undefined && fallback
              ? fallback
              : (operation.security ?? spec.security ?? []).map((requirement) =>
                  Object.keys(requirement).sort(),
                );
          for (const keys of security) {
            if (!keys.length) continue;
            if (keys.some((key) => cookieSchemes.has(key))) continue;
            if (keys.some((key) => oauth.some((method) => method.name === key))) {
              if (keys.length !== 1)
                fail(
                  "combined_oauth",
                  `Tool ${name} combines OAuth with another credential and needs a custom helper.`,
                );
              continue;
            }
            const parts = keys.map(
              (key) =>
                bindings.get(key) ??
                fail("auth_method", `Tool ${name} uses an unsupported authentication method.`),
            );
            const methodName =
              bindings.size === 1 && parts.length === 1 ? "apiKey" : keys.join("_and_");
            methods.set(methodName, {
              name: methodName,
              label: parts.length === 1 ? "API key" : keys.join(" + "),
              bindings: parts.map((part) => ({
                ...part,
                field: parts.length === 1 ? "token" : identifier(part.scheme),
              })),
            });
          }
          const input = schemaDocument(
            { type: "object", properties, required, additionalProperties: false },
            spec.components?.schemas ?? {},
          );
          try {
            jsonSchema(input);
          } catch {
            fail(
              "input_schema",
              `Tool ${name} has an input schema this importer cannot preserve yet.`,
            );
          }
          const outputSchema = responseSchema(
            root,
            operation,
            method.toUpperCase(),
            spec.components?.schemas ?? {},
          );
          const streaming = Object.values(operation.responses ?? {}).some((response) => {
            const content = resolve(root, response).content;
            return content !== undefined && Object.hasOwn(record(content), "text/event-stream");
          });
          operations.push({
            ...(streaming ? { streaming: true as const } : {}),
            name,
            description: operation.summary ?? operation.description ?? name,
            method,
            path,
            baseUrl,
            parameters: requestParameters,
            body,
            security,
            input,
            ...(outputSchema === undefined ? {} : { outputSchema }),
          });
        }
      }
      if (!operations.length) fail("no_operations", "This API does not contain any operations.");
      if (
        !operations.some(
          (operation) =>
            operation.streaming !== true &&
            (operation.security.length === 0 ||
              operation.security.some((keys) =>
                keys.every(
                  (key) => bindings.has(key) || oauth.some((method) => method.name === key),
                ),
              )),
        )
      )
        fail(
          "no_supported_operations",
          "This API has no operations supported by the available authentication and response transports.",
        );
      const secrets = [...methods.values()].sort((a, b) => a.name.localeCompare(b.name));
      const auth = [
        ...secrets.map(
          (method) =>
            `[${serialize(method.name)}]: secrets({ label: ${serialize(method.label)}, fields: object({ ${method.bindings.map((b) => `[${serialize(b.field)}]: string({ minLength: 1 })`).join(", ")} }) })`,
        ),
        ...oauth.map((method) => `[${serialize(method.name)}]: ${method.declaration}`),
      ];
      const hasAccount = auth.length > 0;
      return {
        toolCount: operations.length,
        operations,
        methods: Object.fromEntries(secrets.map((method) => [method.name, method.bindings])),
        oauth: oauth.map(({ name }) => name),
        files: Schema.decodeUnknownSync(SourceFiles)([
          {
            path: "index.ts",
            content: `import { defineApp${hasAccount ? ", accountOperations" : ""} } from "apps"\nimport { openapiOperations } from "apps/openapi"\n${hasAccount ? 'import { provider } from "./provider.ts"\n' : ""}import operations from "./operations.json"\n\nexport default defineApp({ accounts: ${hasAccount ? "{ service: provider.many() }" : "{}"} }, async ({ accounts, signal }) =>\n  ${hasAccount ? "accountOperations(accounts.service, async (account) => " : ""}openapiOperations({\n    operations,\n    methods: ${serialize(Object.fromEntries(secrets.map((m) => [m.name, m.bindings])))},\n    oauth: ${serialize(oauth.map(({ name }) => name))},\n${hasAccount ? "    account,\n" : ""}    signal,\n  })${hasAccount ? ", { signal })" : ""},\n)\n`,
          },
          ...(hasAccount
            ? [
                {
                  path: "provider.ts",
                  content: `import { defineProvider, object, string, secrets, oauth2 } from "apps"\n\nexport const provider = defineProvider({ name: ${serialize(entry.name)}, auth: {\n  ${auth.join(",\n  ")}\n} })\n`,
                },
              ]
            : []),
          { path: "operations.json", content: serialize(operations) },
          packageFile(entry.name),
        ]),
      };
    },
    catch: (error) =>
      error instanceof TemplateError
        ? error
        : new TemplateError({
            code: "invalid_document",
            reason:
              "This API definition could not be read. It may contain unsupported OpenAPI features.",
          }),
  });

/** Compile credential-free metadata for bundled apps using the same importer as deployed apps. */
export const compileOpenApi = (
  entry: OpenApiImport,
  document: unknown,
  options: { readonly baseUrl?: string } = {},
) =>
  generateDefinition(entry, document, options).pipe(
    Effect.map(({ operations, methods, oauth }) => ({ operations, methods, oauth })),
  );

/** Generate editable OpenAPI source; product overrides must already be applied to the document. */
export const generateOpenApiApp = (
  entry: OpenApiImport,
  document: unknown,
  options: { readonly baseUrl?: string } = {},
) =>
  Effect.gen(function* () {
    const generated = yield* generateDefinition(entry, document, options);
    return {
      toolCount: generated.toolCount,
      files: yield* sourceFiles(generated.files),
      metadata: {
        operations: generated.operations,
        methods: generated.methods,
        oauth: generated.oauth,
      },
    };
  });
