// ---------------------------------------------------------------------------
// @executor-js/sdk health-check vocabulary (browser-safe).
//
// A health check is a single declared, authenticated operation a connection can
// run to answer two questions at once: "is this credential still alive?" and
// "whose account is this?". The plugin owns WHICH operation (it lives in the
// plugin's opaque integration config, picked by the user the same way auth
// methods are configured); core owns the shared vocabulary below so every
// surface (API, React, plugins) speaks the same shapes.
//
// The probe runs an operation with optional pinned `args` (Google's People API
// needs `resourceName=people/me`; there is no zero-arg identity endpoint), maps
// the HTTP status to a `HealthStatus`, and extracts a display `identity` from a
// dot-path on the response body. Everything here is pure Effect/Schema with no
// server/node imports so it is safe to import from React.
// ---------------------------------------------------------------------------

import { Schema } from "effect";

// ---------------------------------------------------------------------------
// Status: the five states a connection can be in. `expired` is the one this
// whole feature exists for (Google's 7-day dev-token revocation): the credential
// authenticated fine yesterday and now returns 401/403. `misconfigured` is the
// 403 that is NOT a credential problem: the token authenticated, but the
// upstream rejects on configuration (a Google API not enabled in the OAuth
// client's GCP project): the fix is in the provider console, so telling the
// user to reconnect would mislead. `degraded` covers any other non-2xx
// (upstream 5xx, a 404 on a mis-picked operation); `unknown` is "never checked
// / no health check configured".
// ---------------------------------------------------------------------------

export const HealthStatus = Schema.Literals([
  "healthy",
  "expired",
  "misconfigured",
  "degraded",
  "unknown",
]);
export type HealthStatus = typeof HealthStatus.Type;

// ---------------------------------------------------------------------------
// HealthCheckSpec, the persisted configuration: which operation to run, any
// pinned arguments, and the dot-path to the identity field. Stored inside the
// owning plugin's opaque integration config; core never parses it (the plugin
// reads it back in `checkHealth`).
// ---------------------------------------------------------------------------

export const HealthCheckSpec = Schema.Struct({
  /** The tool / operation name to invoke (the plugin maps this to its binding). */
  operation: Schema.String,
  /** Pinned arguments merged into the probe call. Required for identity
   *  endpoints that take a fixed parameter (e.g. People API `resourceName`). */
  args: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  /** Dot-path into the successful response body whose value is shown as the
   *  connection's identity (e.g. `emailAddresses.0.value`, `user.login`). */
  identityField: Schema.optional(Schema.String),
});
export type HealthCheckSpec = typeof HealthCheckSpec.Type;

// ---------------------------------------------------------------------------
// HealthCheckResponseSample: one scalar leaf from the actual response body,
// `path` (the dot-path that would resolve it) plus `value` (a truncated string
// rendering). The live preview shows these so the user can see what the chosen
// operation really returns and pick the right identity field. Sampled from the
// real response, so it works even when a spec's response schema is thin/absent.
// ---------------------------------------------------------------------------

export const HealthCheckResponseSample = Schema.Struct({
  path: Schema.String,
  value: Schema.String,
});
export type HealthCheckResponseSample = typeof HealthCheckResponseSample.Type;

// ---------------------------------------------------------------------------
// HealthCheckResult: the outcome of running a probe. `httpStatus` and `detail`
// are diagnostic; `identity` is the extracted display value when the check
// succeeded and an `identityField` was configured (and resolved); `responseSample`
// carries a bounded set of the actual returned fields for the live preview.
// ---------------------------------------------------------------------------

export const HealthCheckResult = Schema.Struct({
  status: HealthStatus,
  /** The HTTP status the probe observed, when the check ran against HTTP. */
  httpStatus: Schema.optional(Schema.Number),
  /** Display identity extracted from `identityField`, when present. */
  identity: Schema.optional(Schema.String),
  /** Epoch ms the check ran. */
  checkedAt: Schema.Number,
  /** Human-readable diagnostic (error message, "no health check configured"). */
  detail: Schema.optional(Schema.String),
  /** Bounded sample of scalar fields from the response body, for the live
   *  preview ("show me what this operation returns"). */
  responseSample: Schema.optional(Schema.Array(HealthCheckResponseSample)),
});
export type HealthCheckResult = typeof HealthCheckResult.Type;

// ---------------------------------------------------------------------------
// HealthCheckCandidate: one operation the user can pick as the health check,
// projected from the plugin's stored operations. The editor lists these ranked
// (non-destructive first, then fewest required args) so the obvious "GET /me"
// style identity endpoint floats to the top.
// ---------------------------------------------------------------------------

export const HealthCheckCandidateParameter = Schema.Struct({
  name: Schema.String,
  /** Where the parameter is carried (e.g. "query", "path", "header"). */
  location: Schema.String,
  required: Schema.Boolean,
  description: Schema.optional(Schema.String),
});
export type HealthCheckCandidateParameter = typeof HealthCheckCandidateParameter.Type;

// ---------------------------------------------------------------------------
// HealthCheckResponseField: one scalar leaf the candidate operation can return,
// projected from its response schema: `path` (the dot-path to set as
// `HealthCheckSpec.identityField`) and a `type` display label ("string",
// "number", "string[]", …). Feeds the typed identity picker.
// ---------------------------------------------------------------------------

export const HealthCheckResponseField = Schema.Struct({
  path: Schema.String,
  type: Schema.String,
});
export type HealthCheckResponseField = typeof HealthCheckResponseField.Type;

export const HealthCheckCandidate = Schema.Struct({
  /** The operation / tool name to store as `HealthCheckSpec.operation`. */
  operation: Schema.String,
  /** HTTP method, lower-cased ("get", "post", …), for display + ranking. */
  method: Schema.String,
  /** How many parameters are required to call it (ranking key: fewer is better). */
  requiredArgCount: Schema.Number,
  /** True for mutating methods (post/put/patch/delete), ranked last and shown
   *  with a warning, since a health check should be safe to run repeatedly. */
  destructive: Schema.Boolean,
  /** Operation summary / description for display, when known. */
  summary: Schema.optional(Schema.String),
  /** The operation's parameters, so the editor can offer pinned-arg inputs. */
  parameters: Schema.optional(Schema.Array(HealthCheckCandidateParameter)),
  /** Scalar leaves from the operation's response schema, for the typed identity
   *  picker. Projected via `projectResponseFields`. */
  responseFields: Schema.optional(Schema.Array(HealthCheckResponseField)),
});
export type HealthCheckCandidate = typeof HealthCheckCandidate.Type;

// ---------------------------------------------------------------------------
// Pure helpers, shared so classification + identity extraction behave
// identically wherever a probe is interpreted.
// ---------------------------------------------------------------------------

/** Map an HTTP status to a health state: 2xx healthy, 401/403 expired (the auth
 *  wall), everything else degraded. Status-only fallback: when the response
 *  BODY is available, use `classifyProbeResponse` instead, which tells a
 *  credential 403 apart from a configuration 403. */
export const classifyHttpStatus = (status: number): HealthStatus => {
  if (status >= 200 && status < 300) return "healthy";
  if (status === 401 || status === 403) return "expired";
  return "degraded";
};

// Error `reason` / `status` markers that make a 403 a CONFIGURATION rejection
// rather than a credential one. Deliberately narrow and provider-shaped:
// Google's error envelope carries `errors[].reason: "accessNotConfigured"`
// (message "<API> has not been used in project N before or it is disabled")
// and newer surfaces use `status: "PERMISSION_DENIED"` with
// `details[].reason: "SERVICE_DISABLED"`. Unrecognized 403s keep the expired
// classification: a false "expired" prompts a harmless reconnect, but a false
// "misconfigured" would hide a genuinely dead credential.
const CONFIGURATION_403_REASONS = new Set(["accessnotconfigured", "service_disabled"]);

/** Collect candidate `reason` markers from a Google-shaped error envelope:
 *  `error.errors[].reason` (classic) and `error.details[].reason` (newer
 *  google.rpc.ErrorInfo). Tolerant of partial shapes; returns []. */
const errorReasonMarkers = (body: unknown): string[] => {
  if (body == null || typeof body !== "object") return [];
  const error = (body as Record<string, unknown>)["error"];
  if (error == null || typeof error !== "object") return [];
  const markers: string[] = [];
  for (const key of ["errors", "details"] as const) {
    const entries = (error as Record<string, unknown>)[key];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (entry == null || typeof entry !== "object") continue;
      const reason = (entry as Record<string, unknown>)["reason"];
      if (typeof reason === "string") markers.push(reason.toLowerCase());
    }
  }
  return markers;
};

/** Classify a probe response from its status AND body. Everything is
 *  `classifyHttpStatus` except one carve-out: a 403 whose error body carries a
 *  known configuration reason (Google `accessNotConfigured` /
 *  `SERVICE_DISABLED`) is `misconfigured`, not `expired`: the credential
 *  authenticated; the upstream API is disabled in the OAuth client's project,
 *  and only enabling it there (not reconnecting) fixes it. */
export const classifyProbeResponse = (status: number, body: unknown): HealthStatus => {
  const byStatus = classifyHttpStatus(status);
  if (status !== 403 || byStatus !== "expired") return byStatus;
  return errorReasonMarkers(body).some((reason) => CONFIGURATION_403_REASONS.has(reason))
    ? "misconfigured"
    : "expired";
};

/** Resolve a dot-path (`a.b.0.c`) against a JSON value and coerce the leaf to a
 *  display string. Numeric segments index arrays. Returns undefined when the
 *  path is empty, missing, or lands on a non-scalar. */
export const extractIdentity = (data: unknown, dotpath?: string): string | undefined => {
  if (dotpath == null || dotpath.length === 0) return undefined;
  let current: unknown = data;
  for (const segment of dotpath.split(".")) {
    if (current == null) return undefined;
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) return undefined;
      current = current[index];
      continue;
    }
    if (typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  if (typeof current === "string") return current;
  if (typeof current === "number" || typeof current === "boolean") return String(current);
  return undefined;
};

/** The best identity tier among a candidate's response fields, or -1 when its
 *  schema exposes nothing account-naming. Feeds the identity-aware ranking:
 *  a call that returns an email is a better probe than a generic list.
 *
 *  Only SINGULAR paths count: an identity field under an array segment
 *  (`aliases.0.creator.email`) names people in a collection, not the caller,
 *  and must not out-rank the actual whoami call (`user.email`). */
export const candidateIdentityTier = (candidate: HealthCheckCandidate): number => {
  let best = -1;
  for (const field of candidate.responseFields ?? []) {
    if (field.path.split(".").some((segment) => /^\d+$/.test(segment))) continue;
    const tier = identityPathTier(field.path);
    if (tier === -1) continue;
    if (best === -1 || tier < best) best = tier;
  }
  return best;
};

/** Sort candidates identity-first: non-destructive before destructive, then
 *  calls whose response carries an identity field (email beats login beats
 *  name), then the generic order (fewest required args, GET first,
 *  alphabetical). Tiers are computed once per candidate, not per comparison:
 *  the field walk is linear in response fields and the comparator runs
 *  O(n log n) times on Graph-sized specs. */
export const sortHealthCheckCandidatesByIdentity = (
  candidates: readonly HealthCheckCandidate[],
): HealthCheckCandidate[] =>
  candidates
    .map((candidate) => ({ candidate, tier: candidateIdentityTier(candidate) }))
    .sort((a, b) => {
      if (a.candidate.destructive !== b.candidate.destructive)
        return a.candidate.destructive ? 1 : -1;
      if (a.tier !== b.tier) {
        if (a.tier === -1) return 1;
        if (b.tier === -1) return -1;
        return a.tier - b.tier;
      }
      return compareHealthCheckCandidates(a.candidate, b.candidate);
    })
    .map(({ candidate }) => candidate);

/** Stable ranking for the candidate list: non-destructive before destructive,
 *  then fewest required args, then by method (get first), then alphabetical.
 *  Returns a negative/zero/positive comparator value. */
export const compareHealthCheckCandidates = (
  a: HealthCheckCandidate,
  b: HealthCheckCandidate,
): number => {
  if (a.destructive !== b.destructive) return a.destructive ? 1 : -1;
  if (a.requiredArgCount !== b.requiredArgCount) return a.requiredArgCount - b.requiredArgCount;
  if (a.method !== b.method) {
    if (a.method === "get") return -1;
    if (b.method === "get") return 1;
    return a.method < b.method ? -1 : 1;
  }
  return a.operation < b.operation ? -1 : a.operation > b.operation ? 1 : 0;
};

// ---------------------------------------------------------------------------
// Response-field projection: two pure walkers that feed the typed identity
// picker and the live preview. `projectResponseFields` walks a (normalized)
// response SCHEMA to enumerate selectable identity paths; `extractResponseFields`
// walks an actual response BODY so the preview can show what the operation
// really returns even when the schema is thin or absent.
// ---------------------------------------------------------------------------

const SCALAR_TYPE_LABELS: Record<string, string> = {
  string: "string",
  number: "number",
  integer: "number",
  boolean: "boolean",
};

/** Pick the first non-null entry of an OpenAPI `type` (which may be a union like
 *  `["string", "null"]`), as a string or undefined. */
const primaryType = (raw: unknown): string | undefined => {
  if (Array.isArray(raw)) {
    const found = raw.find((x) => typeof x === "string" && x !== "null");
    return typeof found === "string" ? found : undefined;
  }
  return typeof raw === "string" ? raw : undefined;
};

/** Flatten one schema node's composition into a single effective shape: follow
 *  `$ref`s and merge the properties of EVERY `allOf`/`oneOf`/`anyOf` member, so a
 *  discriminated union (or multi-member allOf) contributes the union of all its
 *  branches' fields, not just the first. Returns the merged properties, any array
 *  `items`, a scalar type label (when the node is a leaf), and the set of refs
 *  followed (so children inherit a cycle guard). */
const flattenSchemaShape = (
  node: unknown,
  defs: Record<string, unknown>,
  seenRefs: ReadonlySet<string>,
): {
  readonly props: Map<string, unknown>;
  readonly items: unknown;
  readonly scalarType: string | undefined;
  readonly refs: ReadonlySet<string>;
} => {
  const props = new Map<string, unknown>();
  let items: unknown = undefined;
  let scalarType: string | undefined;
  const refs = new Set<string>(seenRefs);
  // Bounded work queue over composition members (refs + allOf/oneOf/anyOf) at
  // this one level; the guard bounds pathological self-referential composition.
  const stack: unknown[] = [node];
  let guard = 0;
  while (stack.length > 0 && guard++ < 500) {
    const current = stack.pop();
    if (current == null || typeof current !== "object") continue;
    const s = current as Record<string, unknown>;

    const ref = s["$ref"];
    if (typeof ref === "string") {
      const name = ref.startsWith("#/$defs/") ? ref.slice("#/$defs/".length) : undefined;
      if (name !== undefined && !refs.has(name)) {
        refs.add(name);
        const target = defs[name];
        if (target != null && typeof target === "object") stack.push(target);
      }
      continue;
    }

    for (const key of ["allOf", "oneOf", "anyOf"] as const) {
      const members = s[key];
      if (Array.isArray(members)) for (const member of members) stack.push(member);
    }

    const type = primaryType(s["type"]);
    if (type !== undefined && SCALAR_TYPE_LABELS[type] !== undefined)
      scalarType = SCALAR_TYPE_LABELS[type];
    if (items === undefined && s["items"] !== undefined) items = s["items"];
    const ownProps = s["properties"];
    if (ownProps != null && typeof ownProps === "object") {
      for (const [key, child] of Object.entries(ownProps as Record<string, unknown>)) {
        if (!props.has(key)) props.set(key, child);
      }
    }
  }
  return { props, items, scalarType, refs };
};

/**
 * Enumerate the scalar leaves of a response schema as selectable identity paths.
 * Returns dot-paths (`a.b.0.c`) paired with a display type label. Array items use
 * the literal `"0"` segment to match `extractIdentity`'s numeric-index
 * convention. Resolves `#/$defs/X` refs against `defs` with a cycle guard, and
 * merges ALL `allOf`/`oneOf`/`anyOf` members so discriminated-union branches each
 * contribute their fields. Traverses BREADTH-FIRST so shallow scalars (`email`,
 * `id`, `username`) are emitted before deep nested fields and aren't starved by
 * the field cap. Bounded to depth 5 and 50 (deduped) fields.
 */
export const projectResponseFields = (
  schema: unknown,
  defs: Record<string, unknown> = {},
): HealthCheckResponseField[] => {
  const fields: HealthCheckResponseField[] = [];
  const seenPaths = new Set<string>();
  const MAX_DEPTH = 5;
  const MAX_FIELDS = 50;
  const MAX_FRONTIER = 2000;

  type Item = {
    readonly node: unknown;
    readonly path: string;
    readonly depth: number;
    readonly seenRefs: ReadonlySet<string>;
  };

  let frontier: Item[] = [{ node: schema, path: "", depth: 0, seenRefs: new Set<string>() }];
  while (frontier.length > 0 && fields.length < MAX_FIELDS) {
    const nextFrontier: Item[] = [];
    for (const item of frontier) {
      if (fields.length >= MAX_FIELDS) break;
      if (item.node == null || typeof item.node !== "object") continue;
      const { props, items, scalarType, refs } = flattenSchemaShape(item.node, defs, item.seenRefs);

      // Object: queue children one level deeper (shallow fields emit first).
      if (props.size > 0) {
        for (const [key, child] of props) {
          if (nextFrontier.length >= MAX_FRONTIER) break;
          nextFrontier.push({
            node: child,
            path: item.path === "" ? key : `${item.path}.${key}`,
            depth: item.depth + 1,
            seenRefs: refs,
          });
        }
        continue;
      }
      // Array: descend into items with the numeric-index segment.
      if (items !== undefined) {
        nextFrontier.push({
          node: items,
          path: item.path === "" ? "0" : `${item.path}.0`,
          depth: item.depth + 1,
          seenRefs: refs,
        });
        continue;
      }
      // Scalar leaf.
      if (scalarType !== undefined && item.path !== "" && !seenPaths.has(item.path)) {
        seenPaths.add(item.path);
        fields.push({ path: item.path, type: scalarType });
      }
    }
    frontier = nextFrontier.filter((item) => item.depth <= MAX_DEPTH);
  }
  return fields;
};

/**
 * Walk an actual JSON response body and return its scalar leaves as
 * `{ path, value }` rows (value stringified + truncated). Drives the live
 * preview's "show me what this returns" list. Bounded to depth 4, 25 fields,
 * and ~120-char values.
 */
export const extractResponseFields = (data: unknown): HealthCheckResponseSample[] => {
  const out: HealthCheckResponseSample[] = [];
  const MAX_DEPTH = 4;
  const MAX_FIELDS = 25;
  const MAX_VALUE = 120;

  const render = (v: string): string => (v.length > MAX_VALUE ? `${v.slice(0, MAX_VALUE)}...` : v);

  const visit = (node: unknown, path: string, depth: number) => {
    if (out.length >= MAX_FIELDS || node == null) return;

    if (Array.isArray(node)) {
      if (depth >= MAX_DEPTH) return;
      for (let i = 0; i < node.length; i++) {
        if (out.length >= MAX_FIELDS) break;
        visit(node[i], path === "" ? String(i) : `${path}.${i}`, depth + 1);
      }
      return;
    }

    if (typeof node === "object") {
      if (depth >= MAX_DEPTH) return;
      for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
        if (out.length >= MAX_FIELDS) break;
        visit(child, path === "" ? key : `${path}.${key}`, depth + 1);
      }
      return;
    }

    if (
      path !== "" &&
      (typeof node === "string" || typeof node === "number" || typeof node === "boolean")
    ) {
      out.push({ path, value: render(String(node)) });
    }
  };

  visit(data, "", 0);
  return out;
};

// ---------------------------------------------------------------------------
// Identity auto-pick: choose the response field that most likely names the
// account, so the connect flow can default the identity instead of asking.
// Ranked by how account-naming the leaf key is (email > login/username >
// name/displayName > id), shallower paths first within a tier. Returns
// undefined when nothing plausible exists (pure liveness check).
// ---------------------------------------------------------------------------

const IDENTITY_KEY_TIERS: readonly (readonly string[])[] = [
  ["email", "emailaddress", "mail", "userprincipalname"],
  ["login", "username", "handle", "slug"],
  ["displayname", "name", "fullname"],
  ["id", "userid", "accountid"],
];

/** How account-naming a dot-path's leaf key is: tier index (0 = email, best),
 *  or -1 when it doesn't look like an identity at all. Shared by the sample
 *  picker below and the candidate ranking in the connect flow. */
export const identityPathTier = (path: string): number => {
  const segments = path.split(".");
  const named = segments.filter((segment) => !/^\d+$/.test(segment));
  const leaf = (named[named.length - 1] ?? "").toLowerCase();
  return IDENTITY_KEY_TIERS.findIndex((keys) => keys.includes(leaf));
};

/** Order sample rows identity-first: rows whose leaf key names the account
 *  (email > login > name > id) come before the rest, which keep response
 *  order. Every surface that renders a probe response uses this, so the
 *  interesting fields always lead. Stable within tiers. */
export const rankResponseSample = (
  sample: readonly HealthCheckResponseSample[],
): HealthCheckResponseSample[] =>
  sample
    .map((row, index) => ({ row, index, tier: identityPathTier(row.path) }))
    .sort((a, b) => {
      if (a.tier !== b.tier) {
        if (a.tier === -1) return 1;
        if (b.tier === -1) return -1;
        return a.tier - b.tier;
      }
      return a.index - b.index;
    })
    .map(({ row }) => row);
