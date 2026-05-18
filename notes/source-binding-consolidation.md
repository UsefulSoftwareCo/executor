# Source Binding Consolidation Notes

Date: 2026-05-17
Status: exploring

## Context

The branch `codex/fix-openapi-add-flow` shipped a focused cleanup of the
OpenAPI add-source API (see `openapi-add-source-api-cleanup.md`). Looking
across the OpenAPI, GraphQL, and MCP plugins while reviewing that work
turned up a much larger duplication problem. This note captures the
direction we're considering before drafting a real plan.

## What's duplicated today

Each of OpenAPI, GraphQL, and MCP independently reimplements the same
source-binding machinery on top of the core `credential_binding` table:

- A plugin-specific `*SourceBindingInput` / `*SourceBindingRef` type that
  is a thin re-skin of core `CredentialBindingInput` / `CredentialBindingRef`.
- A `resolve*SourceBinding` helper that filters bindings by
  `slotKey === slot` and picks the innermost-visible binding whose scope
  rank ≤ the source's owner-scope rank. Identical across plugins.
- A `list*SourceBindings` helper applying the same scope-ceiling filter.
- A `validate*BindingTarget` helper that re-checks the same outer-scope
  rule core's `assertCredentialBindingTargetNotOuter` already enforces.
- A `coreBindingToXxxBinding` adapter that exists only because the
  per-plugin Ref type is a re-skin.
- Per-plugin HTTP endpoints: `setSourceBinding`, `listSourceBindings`,
  `removeSourceBinding`. Same payloads, same semantics, mounted under
  different paths.
- A `canonicalizeCredentialMap` / `canonicalizeAuth` that splits an input
  "shape with secret refs" into a stored shape (with binding sentinels)
  plus a list of bindings to write. Same algorithm per plugin.
- React glue: each plugin re-wires `secret-header-auth`,
  `credential-target-scope`, and `oauth-sign-in` into its own add flow.

Storage-side, each plugin owns nearly-identical child tables:

- OpenAPI: `openapi_source_header`, `openapi_source_query_param`,
  `openapi_source_spec_fetch_header`,
  `openapi_source_spec_fetch_query_param`.
- GraphQL: `graphql_source_header`, `graphql_source_query_param`.
- MCP: `mcp_source_header`, `mcp_source_query_param`.

All eight tables share the exact same columns:
`(source_id, scope_id, name, kind, text_value, slot_key, prefix)`.
They're discriminated only by which logical compartment the plugin is
modeling. They're written and read wholesale per source (bulk delete +
bulk insert; bulk findMany). No query filters by `name`, `slot_key`,
`kind`, or `prefix`. No join uses them. The Drizzle mirrors in
`apps/cloud` and `apps/local` are the only non-store consumers.

## The arbitrary-source-types constraint

We expect to support source types beyond HTTP-ish protocols: CLI
sources (argv + env), database connection strings (templated URIs like
`mysql://user:{{password_slot}}@host/db`), and others we haven't named.

That changes the design center of any shared abstraction:

- The HTTP-flavored vocabulary baked into the current shared bits
  (`header:`, `query_param:`, `prefix`) doesn't generalize.
- A DB source doesn't have headers; a CLI source doesn't have query
  params. The notion of "compartment" is plugin-specific.
- A connection-string source needs interpolation, not just whole-field
  substitution. `prefix` is a degenerate one-hole template; argv and
  URIs want full templating.

The only protocol-agnostic primitive is: _"named slot at
(plugin, source, source_scope, scope) resolving to a value of kind
text | secret | connection."_ That's already what core
`credential_binding` provides.

## Revised consolidation thesis

Core should own the binding primitive, not just the storage.

**Core owns:**

- The `credential_binding` table (today).
- The resolver: given `(pluginId, sourceId, sourceScope, slot, scope)`,
  return the innermost-visible binding subject to the source-scope
  ceiling. Today this is duplicated per plugin.
- Validation: scope-stack membership, "binding target not outer than
  source," secret/connection reachability. The facade already has the
  inner checks; the plugin-side `validate*BindingTarget` helpers can go.
- HTTP endpoints for `setBinding` / `listBindings` / `removeBinding`,
  parameterised by `pluginId` in the path (or payload).
- A small _slot manifest_ concept: each plugin declares, for a given
  source, which slot keys exist, their human-readable labels, expected
  value kind, required/optional, and any rendering hints. The UI uses
  this to render a credential editor for any plugin without bespoke
  React code.

**Plugins own:**

- Their source-shape storage. Whatever's plugin-specific (OpenAPI:
  spec/baseUrl/operations; GraphQL: endpoint/operations; MCP:
  transport/config; DB: connection-string template; CLI: argv/env).
  The nearly-identical child tables go away; shape moves to JSON on
  the source row or whatever structural columns the plugin actually
  needs.
- The wire-format glue: how a resolved slot value becomes an HTTP
  header, an MCP transport handshake parameter, a DB connection
  string, a CLI argv entry.
- Their slot manifest content. OpenAPI generates it from the parsed
  spec; MCP from connect-time metadata; DB from the URI template's
  holes.

**Plugins do not own:**

- Re-skinned binding types.
- Their own resolver / lister / validator.
- Their own `setSourceBinding` HTTP endpoint.
- Hand-written credential-editor React glue, beyond plugin-specific
  manifest hints.

## What this changes vs the current plan

The existing `openapi-add-source-api-cleanup.md` proposes deferred
domain wrappers (`setHeaderValue`, `setQueryParamValue`,
`setOAuthClientCredentials`, `setOAuthConnection`). Under the
consolidated model those wrappers stop making sense — they pre-suppose
HTTP-ish compartments. The consumer-facing API becomes "set this slot
on this source," parameterised by a slot key the plugin's manifest
defines. UX affordances like header preset pickers move into the UI
layer, driven by the manifest.

The plan note's "source shape vs values" split is still right; it just
applies more aggressively. Shape lives in plugin source config (JSON
or columns the plugin actually queries on); values live in core
bindings.

## On `prefix`

`prefix` is a UI/UX affordance for the `Authorization: Bearer <token>`
pattern, generalised to "any prepended literal string." It is stored
in three places (core `ConfiguredCredentialBinding`,
`ScopedSecretCredentialInput`, plugin child-table columns) and
consumed at exactly one site per plugin:

```ts
resolved[name] = value.prefix ? `${value.prefix}${secret}` : secret;
```

No escaping, no suffix, no conditional logic. It exists so the secret
itself doesn't have to bake `Bearer ` into the value and so the UI can
render a separate prefix input next to the secret picker.

It does not generalise to connection strings or argv. The right move
is to drop `prefix` from core entirely and either:

1. Have it live in the plugin's slot manifest as a pure UI hint, with
   the resolver still returning the raw secret value and the plugin
   doing the concatenation in its wire-format layer; or
2. Subsume it into a plugin-owned template ("this slot's value is
   interpolated into this string"), which is the same idea generalised
   to multi-hole shapes.

Either way the resolver stops doing string concatenation.

## On the OpenAPI normalized child tables

In the local-cleanup framing they look wrong because the same four
columns are duplicated four times. In the arbitrary-source-types
framing they look wrong for a deeper reason: they bake HTTP
compartment vocabulary into the schema. They should go away rather
than be consolidated.

Two reasonable destinations:

- **JSON on the source row.** Same place OAuth2 config already lives.
  Access pattern (read all, replace all) already matches what a JSON
  blob gives you.
- **Plugin-owned structural columns where they matter.** If a plugin
  truly benefits from a normalized shape table for its own queries,
  it can have one; OpenAPI/GraphQL/MCP currently don't.

## Open questions

1. **Third-party plugins.** Do we expect plugin authors outside this
   repo? That sets the stability bar for the slot manifest contract
   and the resolver API.
2. **Templating layer.** Is there one core mini-template language
   (`{{slot}}`) that plugins opt into, or is interpolation strictly
   plugin-owned? Shared templating gives consistent UX (preview the
   resolved value in the UI, redact in logs uniformly); per-plugin
   templating gives more freedom but reinvents.
3. **Migration order.** Sketch the core API first and prove it on
   OpenAPI as the proving ground, then port GraphQL and MCP in
   follow-ups. Each step independently mergeable.
4. **Existing PR.** Land or shelve `codex/fix-openapi-add-flow` as-is
   before the bigger consolidation opens; do not swallow the focused
   cleanup into the larger refactor.

## Suggested next steps

- Close out the existing PR.
- Draft a real plan note that specifies the core API surface (resolver
  signature, manifest shape, HTTP endpoints) before touching code.
- Once the shape is agreed, port OpenAPI first: delete the four child
  tables, move shape to source-row storage, replace the plugin-level
  binding helpers with core calls, replace the plugin-level HTTP group
  with a core one.
- Port GraphQL and MCP to match.
- Pick the first arbitrary source type (likely DB connection string or
  CLI) as a forcing function to validate the abstraction works beyond
  HTTP-ish shapes.
