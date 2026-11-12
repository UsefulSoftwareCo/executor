/**
 * The inline document an imported OpenAPI app serves: v1's resolved specification (overrides
 * applied, Google Discovery and Microsoft Graph already OpenAPI), cut to the operations v1 exposed,
 * without webhooks, and without security requirements, because v1 sent each connection's
 * credentials on every request whatever the document declared.
 */
import { Option, Result, Schema } from "effect";
import { JSON_SCHEMA, YAMLException, load as loadYaml } from "js-yaml";
import { isLoopbackHostname } from "@executor-js/utils/url-policy";
import type { V1StaleCategory } from "../../contracts/v1-import-run.ts";
import type { OpenApiConfig, OpenApiOperationRow } from "./formats.ts";
import { Entries, mapEntries, noEntries, parserReason } from "./stored-document.ts";

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const methods = ["get", "put", "post", "delete", "patch", "head", "options", "trace"] as const;

/**
 * A stored specification as an object, the URL v1 stored in its place, or why it is neither,
 * without any of its text.
 */
export type ParsedSpec =
  | { readonly ok: true; readonly document: Json }
  | { readonly ok: "url"; readonly url: string }
  | { readonly ok: false; readonly reason: string };

/** A specification v1 stored only as its URL, which v1 fetched when the integration was added. */
const specificationUrl = (value: unknown) => {
  if (typeof value !== "string") return undefined;
  const url = value.trim();
  return /^https?:\/\//iu.test(url) && URL.canParse(url) ? url : undefined;
};

const kindOf = (value: unknown) =>
  value === null ? "null" : Array.isArray(value) ? "a list" : `a ${typeof value}`;

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
    const url = specificationUrl(yaml);
    return isObject(yaml)
      ? { ok: true, document: yaml }
      : url !== undefined
        ? { ok: "url", url }
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
 * API. The dry run lists it for the importer to handle before the organization moves. The reason
 * names no URL: the specification's URL can carry a key in its user, host, port, path or query.
 */
const noHost = (why: string) =>
  ({
    ok: false,
    reason: `${why} and the integration sets no base URL, so v1 had no host to send its requests to either. Its v2 app needs an absolute API base URL.`,
    stale: "no_base_url",
  }) as const;

/** A URL's scheme when it names one other than http(s), such as `wss`, else undefined. */
const otherScheme = (url: string) => {
  const scheme = /^([a-z][a-z0-9+.-]*):/iu.exec(url)?.[1]?.toLowerCase();
  return scheme === undefined || scheme === "http" || scheme === "https" ? undefined : scheme;
};

/**
 * An operation v1 never reached, which the import leaves out and reports: its server is not
 * http(s), such as a `wss://` channel (v1 sent only HTTP requests), or uses a variable no server
 * defines, which v1 sent unresolved. Keyed as `importedDocument` names operations.
 */
export interface UnreachableOperation {
  readonly method: string;
  readonly path: string;
  readonly stale: Extract<V1StaleCategory, "not_http" | "undefined_server_variable">;
  readonly reason: string;
}

/**
 * Where v1 sent each operation of a document: the configured base URL, else the operation's own
 * first server, else its path's, else the document's, with variables at their defaults. An
 * operation whose server is not http(s), or uses a variable nothing defines, never reached its API
 * in v1 either; it is returned as `unreachable` and its server is not one of the `urls`. Refused
 * when an operation has no absolute URL to send to, and as stale when no operation is reachable.
 */
export const operationBaseUrls = (
  config: OpenApiConfig,
  document: Json,
):
  | {
      readonly ok: true;
      readonly urls: readonly [string, ...string[]];
      readonly unreachable: readonly UnreachableOperation[];
    }
  | {
      readonly ok: false;
      readonly reason: string;
      /** Why v1 could not call it either, which skips the integration; every refusal names one. */
      readonly stale: V1StaleCategory;
    } => {
  if (config.baseUrl !== undefined) return { ok: true, urls: [config.baseUrl], unreachable: [] };
  const documentServer = Array.isArray(document.servers) ? document.servers[0] : undefined;
  const urls = new Set<string>();
  const unreachable: UnreachableOperation[] = [];
  const paths = isObject(document.paths) ? document.paths : {};
  for (const [path, item] of Object.entries(paths)) {
    if (!isObject(item)) continue;
    for (const method of methods) {
      const operation = item[method];
      if (!isObject(operation)) continue;
      const server = firstServers(operation.servers, item.servers, document.servers)[0];
      if (server === undefined) return noHost("Its specification names no server URL");
      const resolved = serverUrl(server, documentServer);
      const raw = isObject(server) && typeof server.url === "string" ? server.url : "";
      const scheme = otherScheme("unresolved" in resolved ? raw : (resolved.url ?? raw));
      if (scheme !== undefined) {
        unreachable.push({
          method,
          path,
          stale: "not_http",
          reason: `Its server URL is ${scheme}, not http(s), and v1 sent only HTTP requests.`,
        });
        continue;
      }
      if ("unresolved" in resolved) {
        unreachable.push({
          method,
          path,
          stale: "undefined_server_variable",
          reason: `Its server URL uses ${resolved.unresolved.map((name) => `{${name}}`).join(", ")}, which no server defines, so v1 never resolved it.`,
        });
        continue;
      }
      if (resolved.url === undefined) return noHost("Its server URL is not absolute");
      urls.add(resolved.url);
    }
  }
  const [head, ...tail] = urls;
  if (head !== undefined) return { ok: true, urls: [head, ...tail], unreachable };
  const [first] = unreachable;
  if (first === undefined)
    return { ok: false, reason: "Its API has no absolute base URL.", stale: "no_base_url" };
  // No operation reached its API in v1. Its reason is the first operation's when they all share it.
  const shared = unreachable.every((operation) => operation.stale === first.stale);
  return {
    ok: false,
    reason: shared
      ? first.reason
      : "None of its operations' server URLs is an http(s) URL v1 could resolve.",
    stale: shared ? first.stale : "undefined_server_variable",
  };
};

/**
 * The origins an imported app sends an account's credentials to: every origin its operations call.
 * v1 sent an integration's credentials to each operation's server, whichever hosts they named, and
 * v2's provider `hosts` keeps them to exactly these.
 */
export const credentialOrigins = (
  urls: readonly [string, ...string[]],
): readonly [string, ...string[]] => {
  const first = new URL(urls[0]).origin;
  const rest = urls.slice(1).map((url) => new URL(url).origin);
  return [first, ...new Set(rest.filter((origin) => origin !== first))];
};

/** The document without these operations, with the components only they reached. */
export const withoutOperations = (
  prepared: { readonly document: Json; readonly named: ReadonlyMap<string, string> },
  operations: ReadonlyArray<{ readonly method: string; readonly path: string }>,
) => {
  const left = new Set(operations.map((operation) => `${operation.method} ${operation.path}`));
  const source = isObject(prepared.document.paths) ? prepared.document.paths : {};
  const paths: Record<string, Json> = {};
  for (const [path, item] of Object.entries(source)) {
    if (!isObject(item)) continue;
    const kept = Object.fromEntries(
      Object.entries(item).filter(([key]) => !left.has(`${key} ${path}`)),
    );
    if (methods.some((method) => isObject(kept[method]))) paths[path] = kept;
  }
  return {
    document: pruneComponents({ ...prepared.document, paths }),
    named: new Map([...prepared.named].filter(([key]) => !left.has(key))),
    removed: [...left].flatMap((key) => {
      const tool = prepared.named.get(key);
      return tool === undefined ? [] : [{ key, tool }];
    }),
  };
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

/**
 * The component each `#/components/<section>/<name>` reference reachable from a value names, as
 * `[section, name]` in JSON. A reference's tokens are read as the compiler reads them: percent
 * decoded, then unescaped, so `#/components/schemas/Paper%20Input` names `Paper Input`.
 */
const references = (value: unknown, found: Set<string>) => {
  if (Array.isArray(value)) for (const item of value) references(item, found);
  else if (isObject(value))
    for (const [key, item] of Object.entries(value))
      if (key === "$ref" && typeof item === "string" && item.startsWith("#/components/")) {
        const [section, name] = item
          .slice("#/components/".length)
          .split("/")
          .map((token) => unescape(safeDecode(token)));
        if (section !== undefined && name !== undefined) found.add(JSON.stringify([section, name]));
      } else references(item, found);
};
const unescape = (token: string) => token.replaceAll("~1", "/").replaceAll("~0", "~");

/**
 * Keep only components the rest of the document reaches, directly or through other components.
 * The components can be the stored document's, read entry by entry, so that only those the rest
 * reaches are parsed.
 */
const pruneComponents = (document: Json) => {
  const components = mapEntries(document.components);
  if (components === undefined) return document;
  const reached = new Set<string>();
  const { components: _components, ...rest } = document;
  references(rest, reached);
  const targets = new Map<string, unknown>();
  const queue = [...reached];
  for (let next = queue.pop(); next !== undefined; next = queue.pop()) {
    const [section, name] = Schema.decodeUnknownSync(Schema.Tuple([Schema.String, Schema.String]))(
      JSON.parse(next),
    );
    const target = child(components.get(section), name);
    targets.set(next, target);
    const more = new Set<string>();
    references(target, more);
    for (const reference of more)
      if (!reached.has(reference)) {
        reached.add(reference);
        queue.push(reference);
      }
  }
  const kept: Json = {};
  for (const section of components.keys) {
    const entries = mapEntries(components.get(section));
    if (section === "securitySchemes" || entries === undefined) continue;
    const names = entries.keys.filter((name) => reached.has(JSON.stringify([section, name])));
    if (names.length > 0)
      kept[section] = Object.fromEntries(
        names.map((name) => [name, targets.get(JSON.stringify([section, name]))]),
      );
  }
  return { ...document, components: kept };
};

/** A map's own value at a key, whether the map is read entry by entry or parsed. */
const child = (node: unknown, key: string) =>
  node instanceof Entries
    ? node.get(key)
    : isObject(node) && Object.hasOwn(node, key)
      ? node[key]
      : undefined;

/**
 * The object a local reference reaches, following references it reaches in turn, or the value
 * itself when it is no reference. An operation can be a reference, which the compiler follows: the
 * cut keeps the operation it reaches, so its security is removed like any other's. A reference
 * that does not resolve, or a cycle, reaches nothing, and neither does one to a whole map the
 * document is read through entry by entry, such as `#/paths`, which is no operation.
 */
const localTarget = (document: Entries, value: unknown): unknown => {
  const seen = new Set<string>();
  let current = value;
  while (isObject(current) && typeof current.$ref === "string") {
    const ref = current.$ref;
    if (seen.has(ref) || !ref.startsWith("#/")) return undefined;
    seen.add(ref);
    let node: unknown = document;
    for (const token of ref.slice(2).split("/").map(unescape))
      node = child(node, safeDecode(token));
    current = node instanceof Entries ? undefined : node;
  }
  return current;
};
const safeDecode = (token: string) => {
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: decodeURIComponent throws on a malformed escape, which is then read literally
  try {
    return decodeURIComponent(token);
  } catch {
    return token;
  }
};

/**
 * The document cut to v1's operations, and v1's tool name for each kept operation by method and
 * document path. An operation matches by method and path template (v1's resolved template when
 * the document names one), and by v1's explicit tool path when the operation names one: a row
 * another operation names as its own is never this one's. An operation
 * no row matches is kept under the name in `compiled` (by method and document path), for the tools
 * v1 bound by compiling the document because it stored no binding for them. TRACE operations are
 * left out, as v2 sends no TRACE requests, and their v1 tools are returned as `traced` (decision 16).
 * The stored document is read entry by entry: each path item once, and the components the cut
 * reaches.
 */
export const importedDocument = (
  document: Entries,
  operations: readonly OpenApiOperationRow[],
  compiled: ReadonlyMap<string, string>,
) => {
  const named = new Map<string, string>();
  const traced = new Set<string>();
  const paths: Record<string, Json> = {};
  const source = mapEntries(document.get("paths")) ?? noEntries;
  const rows = new Map<string, OpenApiOperationRow[]>();
  for (const row of operations) {
    const key = `${row.method.toLowerCase()} ${row.path}`;
    const same = rows.get(key);
    if (same === undefined) rows.set(key, [row]);
    else same.push(row);
  }
  const templateOf = (operation: Json, path: string) =>
    typeof operation["x-executor-pathTemplate"] === "string"
      ? operation["x-executor-pathTemplate"]
      : path;
  // The tool paths operations name for themselves: a row one of them claims is not another's. The
  // path items with an operation a row or `compiled` names are the only ones the cut keeps from.
  const claimed = new Set<string>();
  const bound: Array<readonly [string, Json]> = [];
  for (const path of source.keys) {
    const item = source.get(path);
    if (!isObject(item)) continue;
    let wanted = false;
    for (const method of methods) {
      const operation = localTarget(document, item[method]);
      if (!isObject(operation)) continue;
      if (typeof operation["x-executor-toolPath"] === "string")
        claimed.add(operation["x-executor-toolPath"]);
      wanted ||=
        rows.has(`${method} ${templateOf(operation, path)}`) || compiled.has(`${method} ${path}`);
    }
    if (wanted) bound.push([path, item]);
  }
  for (const [path, item] of bound) {
    const shared: Json = {};
    for (const [key, value] of Object.entries(item))
      if (!(methods as readonly string[]).includes(key)) shared[key] = value;
    for (const method of methods) {
      const operation = localTarget(document, item[method]);
      if (!isObject(operation)) continue;
      const template = templateOf(operation, path);
      const candidates = rows.get(`${method} ${template}`) ?? [];
      // The row of the operation's own tool path, or the only row of its method and template
      // unless another operation names that row's tool as its own: v1 merged documents whose
      // operations share a template, such as Calendar's and Drive's `POST /channels/stop`.
      const explicit = operation["x-executor-toolPath"];
      const own = candidates.find((row) => row.tool === explicit);
      const sole =
        candidates.length === 1 && candidates[0] !== undefined && !claimed.has(candidates[0].tool)
          ? candidates[0]
          : undefined;
      const tool = (own ?? sole)?.tool ?? compiled.get(`${method} ${path}`);
      if (tool === undefined) continue;
      // v2 sends no TRACE requests; the import drops these operations and reports their tools
      // (decision 16).
      if (method === "trace") {
        traced.add(tool);
        continue;
      }
      // v1 called the resolved template; keep a key that only told duplicates apart unless the
      // template already holds this method.
      const key = template !== path && paths[template]?.[method] === undefined ? template : path;
      const { security: _security, ...unsecured } = operation;
      paths[key] = { ...shared, ...paths[key], [method]: unsecured };
      named.set(`${method} ${key}`, tool);
    }
  }
  // Webhooks are requests the API sends, never tools v1 exposed.
  const rest = Object.fromEntries(
    document.keys
      .filter((key) => key !== "security" && key !== "webhooks")
      .map((key) => [key, document.get(key)]),
  );
  return { document: pruneComponents({ ...rest, paths }), named, traced: [...traced].sort() };
};
