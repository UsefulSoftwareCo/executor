# Cancelled MCP calls over HTTP

Effect 4.0.1's `RpcServer.makeProtocolWithHttpEffect` waits for a request's first
message with `Queue.takeAll`, cast to a type without its failure. When the queue
ends with nothing in it, `takeAll` fails with `Cause.Done` and the HTTP handler
fails with it. `McpServer` withholds the response of a call the client cancelled
(`notifications/cancelled`), as the [cancellation utility][cancellation] requires,
so a cancelled `tools/call` whose POST had no other output ended exactly that way.
Clients cancel a call at their own request timeout (the MCP TypeScript SDK's
default is 60 seconds) or when a person stops the agent.

The client received a 500 for a request it had already given up on, and the Cloud
session object reported the failure to Sentry as `Done`, an Executor fault with no
diagnosis.

`effect@4.0.1.patch` changes, in source and distributed JavaScript:

- `rpc/RpcServer`: a queue that ends empty gives an empty body, as a buffered
  response without messages already does, instead of the untyped `Done` failure.
  An empty end alone says nothing about why: a response may also have failed to
  be written.
- `ai/McpServer`: the server records, per HTTP POST, the requests it registered
  and the ones whose response its encoder dropped because the server had
  processed a cancellation for them. The record is made by the server's own code
  at the moment it drops the response. When a POST that carries a request ends
  without output, the HTTP transport answers with an empty `text/event-stream`
  response only if every request of that POST is in the record; the transport
  must answer a request POST with JSON or SSE ([Streamable HTTP][transport]).
  Any other empty end, such as a response whose write failed, fails the request
  with `McpResponseNotWritten` ("The MCP request ended without writing its
  response"), so it stays a 500 and Cloud reports it.

The cancellation notification's own POST still gets an empty `202`. A call
cancelled after it streamed a message, such as an elicitation request, already
ended its event stream without a result and is unchanged.

`mcp-protocol-versions.spec.ts` cancels running calls on the hosted products over
MCP 2025-06-18 and 2025-11-25: one while its app tool runs, before any output,
and one after it streamed an approval request. Each call's POST ends its event
stream without a result, the session keeps serving, and Cloud reports neither
`Done` nor `McpResponseNotWritten`. A failed write cannot be produced through the
product, so that case was checked against a local `McpServer.layerHttp` server
with a fault injected into the response encoder and its defect fallback: it
answers 500 with `McpResponseNotWritten`.

Follow-up, a separate change: a call cancelled through native elicitation, after its
`elicitation/create` was streamed, then receives Effect's internal
`@effect/rpc/Interrupt` message on its event stream. This predates the patch (it happens on
`main` at 519aa91b0) and should be MCP's `notifications/cancelled` instead.

The patch has not been submitted upstream; `effect-smol` main still casts the
failure away. Remove it when an Effect release handles a queue that ends empty
and keeps cancelled request POSTs conforming.

[cancellation]: https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/cancellation
[transport]: https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#sending-messages-to-the-server
