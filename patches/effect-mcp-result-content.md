# Tool result content in the Effect MCP server

Effect's `McpServer.registerToolkit` sends every successful tool result as
one text block holding the result's JSON, with the same value as
`structuredContent`. A tool cannot return other content blocks, so the images and
audio an app tool returns reached the MCP client as base64 inside that text: the
model never saw them, and the bytes counted against the client's text limits
twice ([public issue 2482](https://github.com/UsefulSoftwareCo/executor/issues/2482)).

`effect@4.1.4.patch` adds the `McpServer.ResultContent` tool annotation, in source,
distributed JavaScript and `McpServer.d.ts`. Its value builds a successful
result's `content` and `structuredContent` from the encoded value. The server
decodes what it returns as a `CallToolResult`, so content uses the MCP wire
encoding (image data is base64), and a block that does not decode is an internal
tool error. Declared failures, and tools without the annotation, keep the
default result.

`packages/mcp` annotates `execute`, `call` and `resume` in every elicitation
mode with `executionResultContent`, which moves each MCP image or audio block out
of the result into its own content block. `mcp-direct-calls.spec.ts` checks the
blocks a client receives.

The patch has not been submitted upstream. Remove it when an Effect release lets
a tool choose its result content.
