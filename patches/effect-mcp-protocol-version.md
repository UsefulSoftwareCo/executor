# MCP protocol version header and transport rejections

Effect 4.0.1 rejects a legacy session request that
omits `MCP-Protocol-Version` with an empty `400`, even though the session already
records the version negotiated at `initialize`. The [2025-11-25 transport][header]
says a server that receives no header and can identify the version, for example
from initialization, uses that version. Only an invalid or unsupported header
must be rejected. Its other transport rejections also had empty bodies, which
clients such as the MCP TypeScript SDK print as a bare `Error POSTing to endpoint:`.

`effect@4.0.1.patch` changes `ai/internal/mcpRuntime` and `ai/McpServer` in source
and distributed JavaScript:

- A session request without the header uses the session's negotiated version.
- An unknown header value returns the existing modern
  `UnsupportedProtocolVersionError` (`-32022`), with `supported` and `requested`
  data and the supported list in its message.
- A header that names another supported version than the session's returns a
  `HeaderMismatch` error (`-32020`) naming both versions.
- `initialize` with a session, and a legacy request without one, return
  `InvalidRequest` (`-32600`) saying what to send instead.
- An unknown or expired `Mcp-Session-Id` keeps status `404` and tells the client
  to send `initialize` without the header. Executor's hosts lose sessions when
  they restart or deploy, so this is the error clients see afterwards.
- `layerHttp` rejections made before the body is read now carry a JSON-RPC error
  with `id: null`: a disallowed `Origin` (`403`), a `Content-Type` other than
  `application/json` (`415`), and an `Accept` header that does not list both
  `application/json` and `text/event-stream` (`406`).
- A batch the session cannot accept returns `InvalidRequest` asking for one
  message per POST. A batch rejected while selecting its session or version
  keeps that rejection's status and body, so an unknown session is `404` there too.
- Requests that are not JSON report session and header failures before the
  parse error.

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

Modern `2026-07-28` requests are unchanged apart from the longer unsupported
version message and the bodies above. Version selection at `initialize` is
unchanged: a requested supported version is echoed, otherwise the newest
initialize-based one is chosen. `mcp-protocol-versions.spec.ts` covers the
version, session, media type and batch responses on every product. Hosts refuse
foreign origins before this check, so its `403` is reached only by an origin the
host admits, such as the product's own. That earlier refusal, like authentication
and organization access, is the product's own error and the product renders it;
this patch covers only the runtime's transport rejections.

The patch has not been submitted upstream. Remove it when an Effect release
handles the missing header and explains these rejections.

[header]: https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#protocol-version-header
[session]: https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#session-management
[codes]: https://modelcontextprotocol.io/specification/2026-07-28/basic/index#error-codes
