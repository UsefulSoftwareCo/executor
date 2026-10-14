/**
 * The inline document an imported OpenAPI app serves: v1's resolved specification (overrides
 * applied, Google Discovery and Microsoft Graph already OpenAPI), cut to the operations v1 exposed,
 * without webhooks, and without security requirements, because v1 sent each connection's
 * credentials on every request whatever the document declared.
 */
import { Option, Result, Schema } from "effect";
import { JSON_SCHEMA, YAMLException, load as loadYaml } from "js-yaml";
import { getDomain } from "tldts";
import { isLoopbackHostname } from "@executor-js/utils/url-policy";
import type { OpenApiConfig, OpenApiOperationRow } from "./formats.ts";

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const methods = ["get", "put", "post", "delete", "patch", "head", "options", "trace"] as const;

/** A stored specification as an object, or why it is not one, without any of its text. */
export type ParsedSpec =
  | { readonly ok: true; readonly document: Json }
  | { readonly ok: false; readonly reason: string };

const kindOf = (value: unknown) =>
  value === null ? "null" : Array.isArray(value) ? "a list" : `a ${typeof value}`;

/**
 * The parser's reason up to the first quoted name, tag or value it carries, so a failure names the
 * kind of error and never the specification's text.
 */
const parserReason = (reason: string) => reason.split(/[:"'`!<]/)[0]?.trim() ?? "";

const utf8 = new TextDecoder("utf-8", { fatal: true });
const lossyUtf8 = new TextDecoder("utf-8");

/** The stored bytes' size and anything unusual about their encoding. */
const describeBytes = (bytes: Uint8Array, utf8Valid: boolean) => {
  const notes = [`${bytes.length} bytes`];
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
    notes.push("starts with a byte order mark");
  if (!utf8Valid) notes.push("holds bytes that are not UTF-8");
  if (bytes.includes(0)) notes.push("holds NUL bytes");
  return notes.join(", ");
};

/**
 * Parse the stored bytes as UTF-8 text (a leading byte order mark dropped, bytes that are not
 * UTF-8 read as U+FFFD): JSON, or YAML for specs v1 stored as fetched, read with v1's parser
 * (js-yaml, JSON schema). A repeated key keeps its last value, as JSON does. When neither reads
 * as an object, the reason names the YAML error and its position, and the stored bytes' size and
 * encoding.
 */
export const parseSpec = (bytes: Uint8Array): ParsedSpec => {
  const strict = Result.try({ try: () => utf8.decode(bytes), catch: () => "not UTF-8" });
  const text = Result.isSuccess(strict) ? strict.success : lossyUtf8.decode(bytes);
  const json = Option.getOrUndefined(
    Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))(text),
  );
  if (isObject(json)) return { ok: true, document: json };
  const unreadable = (why: string): ParsedSpec => ({
    ok: false,
    reason: `v1's stored specification could not be read: ${why} (${describeBytes(bytes, Result.isSuccess(strict))}).`,
  });
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: the YAML parser throws on input it cannot read
  try {
    const yaml = loadYaml(text, { schema: JSON_SCHEMA, json: true });
    return isObject(yaml)
      ? { ok: true, document: yaml }
      : unreadable(`it is ${kindOf(yaml)}, not an object`);
  } catch (error) {
    if (!(error instanceof YAMLException))
      return unreadable(
        `reading it as YAML failed with ${error instanceof Error ? error.name : "an unknown error"}`,
      );
    const at =
      error.mark === undefined
        ? ""
        : ` at line ${error.mark.line + 1}, column ${error.mark.column + 1}`;
    return unreadable(`it is not JSON, and as YAML, ${parserReason(error.reason)}${at}`);
  }
};

/**
 * A server's URL with its variables at their defaults, or the variables nothing defines. A path- or
 * operation-level server that uses a variable without declaring it takes the declaration of the
 * same name from the document's first server, whatever that server's URL, as the imported app's
 * router does.
 */
const serverUrl = (
  server: unknown,
  documentServer: unknown,
):
  | { readonly url: string | undefined }
  | { readonly unresolved: readonly [string, ...string[]] } => {
  if (!isObject(server) || typeof server.url !== "string") return { url: undefined };
  const declared = (from: unknown) =>
    isObject(from) && isObject(from.variables) ? from.variables : {};
  const variables = { ...declared(documentServer), ...declared(server) };
  let url = server.url;
  for (const [name, variable] of Object.entries(variables)) {
    const value = isObject(variable) ? variable.default : undefined;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
      url = url.replaceAll(`{${name}}`, String(value));
  }
  const [first, ...rest] = [
    ...new Set([...url.matchAll(/\{([^{}]*)\}/gu)].map((match) => match[1] ?? "")),
  ];
  if (first !== undefined) return { unresolved: [first, ...rest] };
  return { url: URL.canParse(url) ? url : undefined };
};

/** The first non-empty list of servers with a URL, as v1 chose an operation's servers. */
const firstServers = (...lists: readonly unknown[]) =>
  lists
    .map((list) =>
      Array.isArray(list)
        ? list.filter((server) => isObject(server) && typeof server.url === "string" && server.url)
        : [],
    )
    .find((list) => list.length > 0) ?? [];

/**
 * Why an operation has no host: v1 prefixed requests with the configured base URL, else the
 * operation's server, and sent the bare path when neither named a host, which never reached an
 * API. A finished import is not run again, so the person's agent recreates the integration from
 * the fix prompt, which carries the item's name and kind. The reason names no URL: the
 * specification's URL can carry a key in its user, host, port, path or query.
 */
const noHost = (why: string) =>
  ({
    ok: false,
    reason: `${why} and the integration sets no base URL, so v1 had no host to send its requests to either. Use 'Copy fix prompt' to recreate this integration in v2 with an absolute API base URL.`,
  }) as const;

/**
 * Where v1 sent each operation of a document: the configured base URL, else the operation's own
 * first server, else its path's, else the document's, with variables at their defaults. Refused
 * when an operation has no absolute URL to send to, or its server uses a variable nothing defines.
 */
export const operationBaseUrls = (
  config: OpenApiConfig,
  document: Json,
):
  | { readonly ok: true; readonly urls: readonly string[] }
  | { readonly ok: false; readonly reason: string } => {
  if (config.baseUrl !== undefined) return { ok: true, urls: [config.baseUrl] };
  const documentServer = Array.isArray(document.servers) ? document.servers[0] : undefined;
  const urls = new Set<string>();
  const paths = isObject(document.paths) ? document.paths : {};
  for (const item of Object.values(paths)) {
    if (!isObject(item)) continue;
    for (const method of methods) {
      const operation = item[method];
      if (!isObject(operation)) continue;
      const server = firstServers(operation.servers, item.servers, document.servers)[0];
      const resolved = serverUrl(server, documentServer);
      if ("unresolved" in resolved)
        return {
          ok: false,
          reason: `Its server URL uses ${resolved.unresolved.map((name) => `{${name}}`).join(", ")}, which no server defines.`,
        };
      if (server === undefined) return noHost("Its specification names no server URL");
      if (resolved.url === undefined) return noHost("Its server URL is not absolute");
      urls.add(resolved.url);
    }
  }
  return urls.size === 0
    ? { ok: false, reason: "Its API has no absolute base URL." }
    : { ok: true, urls: [...urls] };
};

/**
 * The origins an imported app sends an account's credentials to, from the operations' base URLs,
 * when they belong to one service: hosts under one registrable domain, such as `api.github.com`
 * and `uploads.github.com`, or one host name on several ports. A shared platform's suffix, such
 * as `github.io`, is not one service. Otherwise the distinct hosts, for the refusal.
 */
export const credentialOrigins = (
  urls: readonly string[],
):
  | { readonly ok: true; readonly origins: readonly [string, ...string[]] }
  | { readonly ok: false; readonly hosts: readonly string[] } => {
  const origins = [...new Set(urls.map((url) => new URL(url).origin))];
  const sites = new Set(
    origins.map((origin) => {
      const { hostname } = new URL(origin);
      return getDomain(hostname, { allowPrivateDomains: true }) ?? hostname;
    }),
  );
  const [first, ...rest] = origins;
  if (first !== undefined && sites.size === 1) return { ok: true, origins: [first, ...rest] };
  return { ok: false, hosts: [...new Set(origins.map((origin) => new URL(origin).host))] };
};

/**
 * The hosts among `origins` an account's credentials would reach over plain HTTP. An app that
 * sends credentials to several hosts adds them in its own code, so the outbound guard that keeps
 * placed credentials on HTTPS does not apply to them; the import refuses such hosts instead. HTTP
 * to a loopback name passes, as it does for placed credentials: only a local development host lets
 * apps reach loopback at all, and that traffic never leaves the machine.
 */
export const plainHttpHosts = (origins: readonly string[]) =>
  origins.flatMap((origin) => {
    const url = new URL(origin);
    return url.protocol === "https:" || isLoopbackHostname(url.hostname) ? [] : [url.host];
  });

/** Every `#/components/...` reference reachable from a value. */
const references = (value: unknown, found: Set<string>) => {
  if (Array.isArray(value)) for (const item of value) references(item, found);
  else if (isObject(value))
    for (const [key, item] of Object.entries(value))
      if (key === "$ref" && typeof item === "string" && item.startsWith("#/components/"))
        found.add(item);
      else references(item, found);
};
const unescape = (token: string) => token.replaceAll("~1", "/").replaceAll("~0", "~");

/** Keep only components the rest of the document reaches, directly or through other components. */
const pruneComponents = (document: Json) => {
  const components = isObject(document.components) ? document.components : undefined;
  if (components === undefined) return document;
  const reached = new Set<string>();
  const { components: _components, ...rest } = document;
  references(rest, reached);
  const queue = [...reached];
  for (let next = queue.pop(); next !== undefined; next = queue.pop()) {
    const [section, name] = next.slice("#/components/".length).split("/").map(unescape);
    const sectionValue = section === undefined ? undefined : components[section];
    const target = isObject(sectionValue) && name !== undefined ? sectionValue[name] : undefined;
    const more = new Set<string>();
    references(target, more);
    for (const reference of more)
      if (!reached.has(reference)) {
        reached.add(reference);
        queue.push(reference);
      }
  }
  const kept: Json = {};
  for (const [section, entries] of Object.entries(components)) {
    if (section === "securitySchemes" || !isObject(entries)) continue;
    const names = Object.keys(entries).filter((name) =>
      reached.has(`#/components/${section}/${name.replaceAll("~", "~0").replaceAll("/", "~1")}`),
    );
    if (names.length > 0)
      kept[section] = Object.fromEntries(names.map((name) => [name, entries[name]]));
  }
  return { ...document, components: kept };
};

/**
 * The document cut to v1's operations, and v1's tool name for each kept operation by method and
 * document path. An operation matches by method and path template (v1's resolved template when
 * the document names one), then by v1's explicit tool path where several share both. An operation
 * no row matches is kept under the name in `compiled` (by method and document path), for the tools
 * v1 bound by compiling the document because it stored no binding for them.
 */
export const importedDocument = (
  document: Json,
  operations: readonly OpenApiOperationRow[],
  compiled: ReadonlyMap<string, string>,
) => {
  const named = new Map<string, string>();
  const paths: Record<string, Json> = {};
  const source = isObject(document.paths) ? document.paths : {};
  for (const [path, item] of Object.entries(source)) {
    if (!isObject(item)) continue;
    const shared: Json = {};
    for (const [key, value] of Object.entries(item))
      if (!(methods as readonly string[]).includes(key)) shared[key] = value;
    for (const method of methods) {
      const operation = item[method];
      if (!isObject(operation)) continue;
      const template =
        typeof operation["x-executor-pathTemplate"] === "string"
          ? operation["x-executor-pathTemplate"]
          : path;
      const candidates = operations.filter(
        (row) => row.method.toLowerCase() === method && row.path === template,
      );
      const explicit = operation["x-executor-toolPath"];
      const tool =
        (candidates.length > 1 ? candidates.find((row) => row.tool === explicit) : candidates[0])
          ?.tool ?? compiled.get(`${method} ${path}`);
      if (tool === undefined) continue;
      // v1 called the resolved template; keep a key that only told duplicates apart unless the
      // template already holds this method.
      const key = template !== path && paths[template]?.[method] === undefined ? template : path;
      const { security: _security, ...unsecured } = operation;
      paths[key] = { ...shared, ...paths[key], [method]: unsecured };
      named.set(`${method} ${key}`, tool);
    }
  }
  // Webhooks are requests the API sends, never tools v1 exposed.
  const { security: _security, webhooks: _webhooks, ...rest } = document;
  return { document: pruneComponents({ ...rest, paths }), named };
};

const OperationNaming = Schema.Struct({
  operationId: Schema.optional(Schema.String),
  tags: Schema.optional(Schema.Array(Schema.Unknown)),
});

/**
 * Each operation of the imported document as v2's name planner reads it (operationId, first
 * non-empty tag, method and path, in document order), with v1's name for it.
 */
export const documentOperations = (prepared: {
  readonly document: Json;
  readonly named: ReadonlyMap<string, string>;
}) => {
  const paths = isObject(prepared.document.paths) ? prepared.document.paths : {};
  return Object.entries(paths).flatMap(([path, item]) =>
    isObject(item)
      ? methods.flatMap((method) => {
          const operation = item[method];
          if (!isObject(operation)) return [];
          const naming = Option.getOrUndefined(
            Schema.decodeUnknownOption(OperationNaming)(operation),
          );
          const tag = naming?.tags?.find(
            (candidate): candidate is string =>
              typeof candidate === "string" && candidate.trim() !== "",
          );
          return [
            {
              operationId: naming?.operationId,
              tag,
              method: method.toUpperCase(),
              path,
              v1: prepared.named.get(`${method} ${path}`),
            },
          ];
        })
      : [],
  );
};
