import { Effect, Option, Predicate } from "effect";
import { Schema } from "effect";

import { parse, resolveSpecText, type ParsedDocument } from "./parse";
import { extract } from "./extract";
import { DocResolver } from "./openapi-utils";
import { HttpMethod, ServerInfo, type ExtractionResult } from "./types";

// ---------------------------------------------------------------------------
// OAuth 2.0 flows — one entry per supported grant type
// ---------------------------------------------------------------------------

/** Scopes declared by a flow: `{ scopeName: description }` */
const OAuth2Scopes = Schema.Record(Schema.String, Schema.String);
const SecuritySchemeType = Schema.Literals(["http", "apiKey", "oauth2", "openIdConnect"]);
type SecuritySchemeType = typeof SecuritySchemeType.Type;

const decodeSecuritySchemeType = Schema.decodeUnknownOption(SecuritySchemeType);

export const OAuth2AuthorizationCodeFlow = Schema.Struct({
  authorizationUrl: Schema.String,
  tokenUrl: Schema.String,
  refreshUrl: Schema.OptionFromOptional(Schema.String),
  scopes: OAuth2Scopes,
});
export type OAuth2AuthorizationCodeFlow = typeof OAuth2AuthorizationCodeFlow.Type;

export const OAuth2ClientCredentialsFlow = Schema.Struct({
  tokenUrl: Schema.String,
  refreshUrl: Schema.OptionFromOptional(Schema.String),
  scopes: OAuth2Scopes,
});
export type OAuth2ClientCredentialsFlow = typeof OAuth2ClientCredentialsFlow.Type;

export const OAuth2Flows = Schema.Struct({
  authorizationCode: Schema.OptionFromOptional(OAuth2AuthorizationCodeFlow),
  clientCredentials: Schema.OptionFromOptional(OAuth2ClientCredentialsFlow),
});
export type OAuth2Flows = typeof OAuth2Flows.Type;

// ---------------------------------------------------------------------------
// Security scheme — what the spec declares it needs
// ---------------------------------------------------------------------------

export const SecurityScheme = Schema.Struct({
  /** Key name in components.securitySchemes (e.g. "api_token") */
  name: Schema.String,
  /** OpenAPI security scheme type */
  type: SecuritySchemeType,
  /** For type: "http" — e.g. "bearer", "basic" */
  scheme: Schema.OptionFromOptional(Schema.String),
  /** For type: "http" with scheme "bearer" — e.g. "JWT" */
  bearerFormat: Schema.OptionFromOptional(Schema.String),
  /** For type: "apiKey" — where the key goes */
  in: Schema.OptionFromOptional(Schema.Literals(["header", "query", "cookie"])),
  /** For type: "apiKey" — the header/query/cookie name */
  headerName: Schema.OptionFromOptional(Schema.String),
  description: Schema.OptionFromOptional(Schema.String),
  /** For type: "oauth2" — declared flows (authorizationCode / clientCredentials only; implicit and password are deprecated). */
  flows: Schema.OptionFromOptional(OAuth2Flows),
  /** For type: "openIdConnect" — the discovery URL. */
  openIdConnectUrl: Schema.OptionFromOptional(Schema.String),
});
export type SecurityScheme = typeof SecurityScheme.Type;

// ---------------------------------------------------------------------------
// Auth strategy — a valid combination of security schemes
// ---------------------------------------------------------------------------

export const AuthStrategy = Schema.Struct({
  /** The security schemes required together for this strategy */
  schemes: Schema.Array(Schema.String),
});
export type AuthStrategy = typeof AuthStrategy.Type;

// ---------------------------------------------------------------------------
// Header preset — derived from an auth strategy
// ---------------------------------------------------------------------------

export const HeaderPreset = Schema.Struct({
  /** Human-readable label for the UI (e.g. "Bearer Token", "API Key + Email") */
  label: Schema.String,
  /** Headers this strategy needs. Value is null when the user must provide it. */
  headers: Schema.Record(Schema.String, Schema.NullOr(Schema.String)),
  /** Which headers should be stored as secrets */
  secretHeaders: Schema.Array(Schema.String),
});
export type HeaderPreset = typeof HeaderPreset.Type;

// ---------------------------------------------------------------------------
// OAuth2 preset — derived from an oauth2 security scheme + a flow choice
// ---------------------------------------------------------------------------

export const OAuth2Preset = Schema.Struct({
  /** Human-readable label for the UI (e.g. "OAuth2 (Authorization Code) — oauth_app") */
  label: Schema.String,
  /** The source security scheme this preset came from (components.securitySchemes key). */
  securitySchemeName: Schema.String,
  /** Which OAuth2 flow this preset uses. */
  flow: Schema.Literals(["authorizationCode", "clientCredentials"]),
  /** For authorizationCode: user-agent redirect URL (from the spec). */
  authorizationUrl: Schema.OptionFromOptional(Schema.String),
  /** Token endpoint to exchange the code / refresh. */
  tokenUrl: Schema.String,
  /** Optional refresh endpoint if the spec declares one separately. */
  refreshUrl: Schema.OptionFromOptional(Schema.String),
  /** Declared scopes for this flow: `{ scope: description }`. */
  scopes: Schema.Record(Schema.String, Schema.String),
});
export type OAuth2Preset = typeof OAuth2Preset.Type;

// ---------------------------------------------------------------------------
// Preview operation — lightweight shape for the add-source UI list
// ---------------------------------------------------------------------------

export const PreviewOperation = Schema.Struct({
  operationId: Schema.String,
  method: HttpMethod,
  path: Schema.String,
  summary: Schema.OptionFromOptional(Schema.String),
  tags: Schema.Array(Schema.String),
  deprecated: Schema.Boolean,
});
export type PreviewOperation = typeof PreviewOperation.Type;

// ---------------------------------------------------------------------------
// Spec preview — everything the frontend needs
// ---------------------------------------------------------------------------

export const SpecPreview = Schema.Struct({
  title: Schema.OptionFromOptional(Schema.String),
  version: Schema.OptionFromOptional(Schema.String),
  /** Reuses ServerInfo from extraction */
  servers: Schema.Array(ServerInfo),
  operationCount: Schema.Number,
  /** Lightweight operation list for the add-source UI */
  operations: Schema.Array(PreviewOperation),
  tags: Schema.Array(Schema.String),
  securitySchemes: Schema.Array(SecurityScheme),
  /** Valid auth strategies (each is a set of schemes used together) */
  authStrategies: Schema.Array(AuthStrategy),
  /** Pre-built header presets derived from auth strategies */
  headerPresets: Schema.Array(HeaderPreset),
  /** OAuth2 presets — one per (oauth2 scheme × supported flow) combination */
  oauth2Presets: Schema.Array(OAuth2Preset),
});
export type SpecPreview = typeof SpecPreview.Type;

// ---------------------------------------------------------------------------
// Security scheme extraction
// ---------------------------------------------------------------------------

const stringRecord = (value: unknown): Record<string, string> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
};

const extractFlows = (rawFlows: unknown): Option.Option<OAuth2Flows> => {
  if (!rawFlows || typeof rawFlows !== "object") return Option.none();
  const flows = rawFlows as Record<string, unknown>;

  const parseFlow = <K extends "authorizationCode" | "clientCredentials">(key: K): unknown =>
    flows[key];

  let authorizationCode: Option.Option<OAuth2AuthorizationCodeFlow> = Option.none();
  const authCodeRaw = parseFlow("authorizationCode");
  if (authCodeRaw && typeof authCodeRaw === "object") {
    const f = authCodeRaw as Record<string, unknown>;
    const authUrl = typeof f.authorizationUrl === "string" ? f.authorizationUrl : null;
    const tokenUrl = typeof f.tokenUrl === "string" ? f.tokenUrl : null;
    if (authUrl && tokenUrl) {
      authorizationCode = Option.some(
        OAuth2AuthorizationCodeFlow.make({
          authorizationUrl: authUrl,
          tokenUrl,
          refreshUrl: Option.fromNullishOr(
            typeof f.refreshUrl === "string" ? f.refreshUrl : undefined,
          ),
          scopes: stringRecord(f.scopes),
        }),
      );
    }
  }

  let clientCredentials: Option.Option<OAuth2ClientCredentialsFlow> = Option.none();
  const ccRaw = parseFlow("clientCredentials");
  if (ccRaw && typeof ccRaw === "object") {
    const f = ccRaw as Record<string, unknown>;
    const tokenUrl = typeof f.tokenUrl === "string" ? f.tokenUrl : null;
    if (tokenUrl) {
      clientCredentials = Option.some(
        OAuth2ClientCredentialsFlow.make({
          tokenUrl,
          refreshUrl: Option.fromNullishOr(
            typeof f.refreshUrl === "string" ? f.refreshUrl : undefined,
          ),
          scopes: stringRecord(f.scopes),
        }),
      );
    }
  }

  if (Option.isNone(authorizationCode) && Option.isNone(clientCredentials)) {
    return Option.none();
  }
  return Option.some(OAuth2Flows.make({ authorizationCode, clientCredentials }));
};

const extractSecuritySchemes = (
  rawSchemes: Record<string, unknown>,
  resolver: DocResolver,
): SecurityScheme[] =>
  Object.entries(rawSchemes).flatMap(([name, schemeOrRef]) => {
    if (!schemeOrRef || typeof schemeOrRef !== "object") return [];
    // Resolve $ref so schemes defined via `$ref` aren't silently dropped.
    const resolved = resolver.resolve<Record<string, unknown>>(
      schemeOrRef as Record<string, unknown>,
    );
    if (!resolved || typeof resolved !== "object") return [];
    const scheme = resolved;

    const type = decodeSecuritySchemeType(scheme.type);
    if (Option.isNone(type)) return [];
    const schemeType = type.value;

    return [
      SecurityScheme.make({
        name,
        type: schemeType,
        scheme: Option.fromNullishOr(scheme.scheme as string | undefined),
        bearerFormat: Option.fromNullishOr(scheme.bearerFormat as string | undefined),
        in: Option.fromNullishOr(scheme.in as "header" | "query" | "cookie" | undefined),
        headerName: Option.fromNullishOr(scheme.name as string | undefined),
        description: Option.fromNullishOr(scheme.description as string | undefined),
        flows: schemeType === "oauth2" ? extractFlows(scheme.flows) : Option.none(),
        openIdConnectUrl: Option.fromNullishOr(scheme.openIdConnectUrl as string | undefined),
      }),
    ];
  });

// ---------------------------------------------------------------------------
// Header preset builder
// ---------------------------------------------------------------------------

const buildHeaderPresets = (
  schemes: readonly SecurityScheme[],
  strategies: readonly AuthStrategy[],
): HeaderPreset[] => {
  const schemeMap = new Map(schemes.map((s) => [s.name, s]));

  return strategies.flatMap((strategy) => {
    const resolved = strategy.schemes
      .map((name) => schemeMap.get(name))
      .filter(Predicate.isNotUndefined);

    if (resolved.length === 0) return [];

    const headers: Record<string, string | null> = {};
    const secretHeaders: string[] = [];
    const labelParts: string[] = [];

    for (const scheme of resolved) {
      if (scheme.type === "http" && Option.getOrElse(scheme.scheme, () => "") === "bearer") {
        headers["Authorization"] = null;
        secretHeaders.push("Authorization");
        labelParts.push("Bearer Token");
      } else if (scheme.type === "http" && Option.getOrElse(scheme.scheme, () => "") === "basic") {
        headers["Authorization"] = null;
        secretHeaders.push("Authorization");
        labelParts.push("Basic Auth");
      } else if (scheme.type === "apiKey" && Option.getOrElse(scheme.in, () => "") === "header") {
        const headerName = Option.getOrElse(scheme.headerName, () => scheme.name);
        headers[headerName] = null;
        secretHeaders.push(headerName);
        labelParts.push(scheme.name);
      } else if (scheme.type === "apiKey") {
        labelParts.push(`${scheme.name} (${Option.getOrElse(scheme.in, () => "unknown")})`);
      } else if (scheme.type === "oauth2" || scheme.type === "openIdConnect") {
        return [];
      } else {
        labelParts.push(scheme.name);
      }
    }

    if (Object.keys(headers).length === 0 && resolved.length > 0) {
      return [
        HeaderPreset.make({
          label: labelParts.join(" + "),
          headers: {},
          secretHeaders: [],
        }),
      ];
    }

    return [
      HeaderPreset.make({
        label: labelParts.join(" + "),
        headers,
        secretHeaders,
      }),
    ];
  });
};

// ---------------------------------------------------------------------------
// OAuth2 preset builder
// ---------------------------------------------------------------------------

const buildOAuth2Presets = (schemes: readonly SecurityScheme[]): OAuth2Preset[] => {
  const presets: OAuth2Preset[] = [];
  for (const scheme of schemes) {
    if (scheme.type !== "oauth2") continue;
    if (Option.isNone(scheme.flows)) continue;
    const flows = scheme.flows.value;

    if (Option.isSome(flows.authorizationCode)) {
      const flow = flows.authorizationCode.value;
      presets.push(
        OAuth2Preset.make({
          label: `OAuth2 Authorization Code · ${scheme.name}`,
          securitySchemeName: scheme.name,
          flow: "authorizationCode",
          authorizationUrl: Option.some(flow.authorizationUrl),
          tokenUrl: flow.tokenUrl,
          refreshUrl: flow.refreshUrl,
          scopes: flow.scopes,
        }),
      );
    }

    if (Option.isSome(flows.clientCredentials)) {
      const flow = flows.clientCredentials.value;
      presets.push(
        OAuth2Preset.make({
          label: `OAuth2 Client Credentials · ${scheme.name}`,
          securitySchemeName: scheme.name,
          flow: "clientCredentials",
          authorizationUrl: Option.none(),
          tokenUrl: flow.tokenUrl,
          refreshUrl: flow.refreshUrl,
          scopes: flow.scopes,
        }),
      );
    }
  }
  return presets;
};

// ---------------------------------------------------------------------------
// Collect unique tags from extraction result
// ---------------------------------------------------------------------------

const collectTags = (result: ExtractionResult): string[] => {
  const tagSet = new Set<string>();
  for (const op of result.operations) {
    for (const tag of op.tags) tagSet.add(tag);
  }
  return [...tagSet].sort();
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Preview an OpenAPI spec — extract metadata without registering anything.
 *  Accepts either a URL or raw JSON/YAML text. */
export const previewSpec = Effect.fn("OpenApi.previewSpec")(function* (input: string) {
  const specText = yield* resolveSpecText(input);
  const doc: ParsedDocument = yield* parse(specText);
  const result = yield* extract(doc);

  const resolver = new DocResolver(doc);
  const securitySchemes = extractSecuritySchemes(doc.components?.securitySchemes ?? {}, resolver);

  const rawSecurity = (doc.security ?? []) as Array<Record<string, unknown>>;
  const declaredStrategies = rawSecurity.map((entry) =>
    AuthStrategy.make({ schemes: Object.keys(entry) }),
  );
  // Fall back to one strategy per scheme when the spec only declares schemes
  // under components (e.g. Sentry) so the user still sees auth options.
  const authStrategies =
    declaredStrategies.length > 0
      ? declaredStrategies
      : securitySchemes.map((scheme) => AuthStrategy.make({ schemes: [scheme.name] }));

  return SpecPreview.make({
    title: result.title,
    version: result.version,
    servers: result.servers,
    operationCount: result.operations.length,
    operations: result.operations.map((op) =>
      PreviewOperation.make({
        operationId: op.operationId,
        method: op.method,
        path: op.pathTemplate,
        summary: op.summary,
        tags: op.tags,
        deprecated: op.deprecated,
      }),
    ),
    tags: collectTags(result),
    securitySchemes,
    authStrategies,
    headerPresets: buildHeaderPresets(securitySchemes, authStrategies),
    oauth2Presets: buildOAuth2Presets(securitySchemes),
  });
});
