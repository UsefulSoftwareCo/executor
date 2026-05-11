# Credential Slot UI Refactor Notes

We want to keep the plugin model, but stop making each source UI reinvent the
same credential concepts. OpenAPI, MCP, and GraphQL should still own their
source-specific setup, probing, parsing, auth capabilities, and save payloads.
The shared layer should only cover credential slots, binding values, secret
selection, OAuth connection controls, and product language around ownership.

## Product Direction

- A source has a shared authentication method. Users may be able to override
  credential values for that method, but they cannot switch the method per
  person unless the backend model explicitly supports that.
- Secrets are reusable values that live at a personal or organization ownership
  level.
- Source bindings attach a secret, literal value, or OAuth connection to a
  source slot for a personal or organization usage level.
- The UI should communicate these as separate choices:
  - where a new secret is saved;
  - who uses a source credential binding;
  - where an OAuth connection/token is saved.
- Avoid product copy that exposes "scope" unless it is a developer/debug
  surface.

## Refactor Direction

- Do not introduce a generic HTTP source model.
- Do introduce shared credential-slot UI primitives that plugins compose.
- Plugins should adapt their own source config into shared slot descriptors and
  save the result through plugin-owned atoms/API calls.
- Add and edit flows should reuse the same credential editors where the product
  behavior is the same.
- OpenAPI is the largest cleanup target. MCP and GraphQL are smaller but useful
  for extracting the lower-risk shared pieces first.

## Likely Shared Concepts

- Convert configured credential values plus binding refs into editor state.
- Preserve per-row binding usage scope and selected secret ownership scope.
- Render secret-backed headers and query params with the same picker, preview,
  and "Used by" controls.
- Render OAuth connect/reconnect controls with the same saved-to dropdown and
  validity styling, while keeping plugin-specific OAuth payload construction.
- Report effective vs explicit credential state without each plugin rendering
  bespoke debug/product copy.

## Guardrails

- Do not collapse plugin-specific source models into one abstraction.
- Do not make MCP stdio, MCP remote probing, GraphQL introspection, and OpenAPI
  spec parsing fit a fake common lifecycle.
- Prefer small shared adapters first, then replace bespoke OpenAPI edit pieces
  after the shared API has proven itself in MCP/GraphQL.
