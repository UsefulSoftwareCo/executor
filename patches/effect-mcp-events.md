# MCP events in the Effect MCP server

`effect@4.0.1.patch` also adds the draft MCP events extension's webhook methods to
the `2026-07-28` adapter, in source and distributed JavaScript:

- `McpSchema` gains the public event schemas (`EventDefinition`,
  `ListEventsParams`/`Result`, `SubscribeEventParams`/`Result`,
  `UnsubscribeEventParams`) and the extension's error codes, `NOT_FOUND_ERROR_CODE`
  (`-32011`) through `CALLBACK_ENDPOINT_ERROR_CODE` (`-32015`).
- `McpServer.registerEvents(handler)` and the `McpServer.events(handler)` layer
  register one handler for `events/list`, `events/subscribe` and
  `events/unsubscribe`. Each runs with the request's `McpRequestContext`, like
  tool handlers, so it can authorize the principal. A handler fails with an MCP
  error whose code and data reach the client unchanged.
- With a handler registered, `server/discover` advertises `capabilities.events`
  (`{}`), the `2026-07-28` RPC group accepts the three methods, and the server
  answers them. Without one they stay `MethodNotFound` (`404`), as before.
- Earlier protocol revisions are unchanged; the extension is defined only for
  stateless `2026-07-28` requests.

Only webhook delivery is modelled, which is what ChatGPT implements
(<https://developers.openai.com/plugins/build/mcp-events>). Poll and push
delivery, `notifications/events/*` and `gap`/`terminated` envelopes are not.
The delivery itself is the application's: Executor signs and sends it.

The declarations of the internal modules are left as released; only
`McpSchema.d.ts` and `McpServer.d.ts` describe the additions. The patch is meant
for upstream. Remove this part when an Effect release serves events.
