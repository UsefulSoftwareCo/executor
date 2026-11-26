# MCP transport rejections

Effect 4.1 handles the `MCP-Protocol-Version` header as the [2025-11-25
transport][header] says: a session request without the header uses the version
negotiated at `initialize`, an unknown value returns `UnsupportedProtocolVersionError`
(`-32022`) with `supported` and `requested` data, and a header naming another
supported version than the session's returns `HeaderMismatch` (`-32020`) naming both.
Session and header failures are reported before a parse error. Effect 4.0.1 did none
of this, and a patch carried it.

Other rejections still have an empty body or say less than a client needs. Clients
such as the MCP TypeScript SDK print an empty body as a bare `Error POSTing to
endpoint:`. `effect@4.1.4.patch` changes `ai/internal/mcpRuntime` and `ai/McpServer`
in source and distributed JavaScript:

- An unknown or expired `Mcp-Session-Id` keeps status `404` and tells the client
  to send `initialize` without the header. Executor's hosts lose sessions when
  they restart or deploy, so this is the error clients see afterwards. Effect
  answers with an empty `404`.
- `layerHttp` rejections made before the body is read carry a JSON-RPC error
  with `id: null`: a disallowed `Origin` (`403`), a `Content-Type` other than
  `application/json` (`415`), and an `Accept` header that does not list both
  `application/json` and `text/event-stream` (`406`). Effect answers each with an
  empty body.
- A batch the session cannot accept returns `InvalidRequest` asking for one
  message per POST. A batch rejected while selecting its session or version
  keeps that rejection's status and body, so an unknown session is `404` there too.
  Effect answers both with an empty `400`.
- The unsupported version message lists the supported versions, as its `data` does.
- `initialize` with a session, and a legacy request without one, keep the patch's
  wording: `InvalidRequest` (`-32600`) saying what to send instead. Effect's own
  messages say the same more briefly and spell the header `MCP-Session-Id`; the
  hosts' own session errors and these use `Mcp-Session-Id`.

The transport prescribes `404` for a terminated session ([Session
Management][session]) and `403` for an invalid `Origin`, whose body may be a
JSON-RPC error without an ID. It requires JSON bodies and both media types in
`Accept` but names no status; `415` and `406` are HTTP's. The [2026-07-28 error
codes][codes] define no code for these cases, reserve `-32020` to `-32099` for
codes the specification defines, and say new implementations should not use the
legacy `-32000` to `-32019` range that the TypeScript SDK uses here. These
transport rejections therefore use `-32600`, the standard code for protocol
failures; the status tells them apart.
A `405` for other methods keeps its empty body and `Allow: POST`, and `202`
acknowledgements stay empty as the transport requires.

Version selection at `initialize` is Effect's: a requested supported version is
echoed, otherwise the newest initialize-based one is chosen.
`mcp-protocol-versions.spec.ts` covers the version, session, media type and batch
responses on every product. Hosts refuse foreign origins before this check, so its
`403` is reached only by an origin the host admits, such as the product's own. That
earlier refusal, like authentication and organization access, is the product's own
error and the product renders it; this patch covers only the runtime's transport
rejections.

A call the client cancelled ends its POST with an empty event stream, and a request
that ends without its response fails with `MCP request ended without writing its
response`. Effect 4.1 does both itself; on 4.0.1 a patch did, and failed the second
case as `McpResponseNotWritten`. The same scenario file cancels running calls on the
hosted products.

The patch has not been submitted upstream. Remove each part when an Effect release
explains that rejection.

[header]: https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#protocol-version-header
[session]: https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#session-management
[codes]: https://modelcontextprotocol.io/specification/2026-07-28/basic/index#error-codes
