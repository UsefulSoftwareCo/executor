# SDK vendored json-schema-to-typescript

Vendored SDK-internal compiler code based on `json-schema-to-typescript@15.0.4`.

The Executor copy keeps the schema compiler API used by `@executor-js/sdk` and
removes the Prettier formatting dependency. Generated output is intentionally
left unformatted; callers that display previews should normalize it themselves.
It is not a public package surface.
