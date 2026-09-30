# Vendored json-schema-to-typescript

Vendored SDK-internal compiler code based on Boris Cherny's
`json-schema-to-typescript@15.0.4`.

The Executor copy keeps the schema compiler API used by `@executor-js/sdk` and
removes the Prettier formatting dependency. Generated output is intentionally
left unformatted; callers that display previews should normalize it themselves.
It also resolves only same-document JSON Pointer `$ref`s; external file and URL
refs are rejected rather than fetched or read. It is not a public package
surface.

Sibling `properties` and `patternProperties` beside `allOf`, `anyOf`, or
`oneOf` join the composition as one more intersection member, for inline
schemas as well as `$id`-named ones. A definition's name belongs to the whole
composition, and re-entering a composition through a recursive reference reuses
its cached node. The sibling keywords intersect every branch, including
non-object ones, so a `{ "type": "null" }` alternative beside sibling
properties is absorbed; this matches how `$id`-named definitions already
behaved. Keeping non-object alternatives would need per-branch kind analysis,
which is deliberately not implemented.

The upstream project is MIT licensed; the original copyright notice is included
in `LICENCE.md`.
