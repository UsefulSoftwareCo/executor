# Codemode gives a tool failure properties beside its message

`@opencode-ai%2Fcodemode@0.0.0-dev-19272.patch` also adds an optional `properties` field, a record of
strings, to `ToolError`, and a third argument to `toolError(message, cause, properties)`.

Unpatched, a program that catches a tool's failure gets an `Error` with only `name` and `message`,
and an uncaught one is reported as `{ kind: "ToolFailure", message }`. With the patch:

- The tool runtime, which turns every failure of a tool's `execute` into a new `ToolError` from
  its message, keeps the properties of a `ToolError` the tool failed with.
- The caught error value carries each property as its own field. `name` and `message` are never
  replaced, so the message a program reads is exactly what it was.
- An uncaught `ToolFailure` diagnostic carries them as `properties`, and `CodeMode.Diagnostic`
  declares that optional field so the host's decode keeps it.

Hosted Executor uses it for the tool call log: a failed call's error has `reference`, the call's
`call_` reference that an organization admin can search for (`packages/mcp`'s
`implementation/execute.ts`). A program that rethrows the caught value throws its own value, which
CodeMode reports as `Uncaught: <message>` without the properties.
