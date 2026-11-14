# Cloudflare runtime: keep the client's connection

Local Cloud (`hosted:cloud:dev` and the e2e `cloud` target) serves each Worker
through alchemy's `WorkerProxy`, which used to relay each client connection
byte for byte to one workerd connection. Cloud's Api Worker sits behind the
asset router, so its requests arrive over a binding. When a Worker answers a
request that arrived over a binding without reading its whole body, workerd
closes the connection about 50 µs to 5 ms after the answer and sends no
`Connection: close`. The relay passed that close on to the client. A client
that kept its connection lost the request it sent next whenever its write won
the race with the close: `SocketError: other side closed`. The MCP gateway's
refusals (unknown session, foreign `Origin`, missing or refused bearer) answer
without reading the body, which failed `mcp-protocol-versions.spec.ts` on CI.

Production is not affected: Cloudflare's edge owns the client's connection.
On a test stage built from main (November 2026), each refused MCP POST was
followed by a request on the same HTTP/1.1 connection. Unknown-session (404),
missing-bearer (401) and foreign-`Origin` (403) refusals with small bodies,
at 0, 1, 5, 50 and 200 ms after the answer, 100 times per case and delay;
unknown-session with 70 KB bodies (100 per delay) and 1 MB bodies (50 per
delay) at 0, 5 and 50 ms. All 1,950 next requests were answered, and every
refusal carried `Connection: keep-alive`. Fifty refusals in a row on each of
20 connections were all answered on that connection. The same probes against
workerd with a binding and no proxy lost the connection after every refusal.

`@alchemy.run/cloudflare-runtime@2.0.0-beta.80.patch` adds
`src/core/proxy/KeepAlive.ts` (and its `dist/` build), which the relay now
uses. It follows HTTP/1.1 framing in both directions without changing a
forwarded byte. When the answer to a request that carried a body is complete,
it reads and discards what is left of that body, closes that workerd
connection and sends the client's next request on a new one; a request the
client sends meanwhile is held until then, up to 1 MB before the proxy stops
reading the client. Requests without a body keep their workerd connection. A
workerd connection that closes between exchanges no longer ends the client's.
An upgrade (WebSocket), `CONNECT`, a response that runs to the close, or a head
it cannot parse makes the connection a plain pipe again, as before; what it
held goes to workerd first, in order, so workerd sees what a plain pipe would
have sent. This is the rule the self-host host proxy follows
([notes/self-host-workerd.md](../notes/self-host-workerd.md#kept-alive-connections)),
except that the client is never told to close.

The proxy stops reading the client only while workerd's connection is full or
more than 1 MB is held. Once an answer is complete, nothing more is written to
that workerd connection, so the client is read again even if workerd never
reads another byte or resets the connection: the rest of the body is read and
discarded at the client's pace.

Two things differ from production. A Worker that reads a request's body after
answering it (in `waitUntil`, for example) never gets the part that arrives
after the answer, because that is the part the proxy discards. And a client
whose workerd connection closes between exchanges sends its next request to
the address it was first given: when workerd is replaced, the proxy resets
clients pinned to the old one, as before, but if workerd died instead, that
request is reset rather than answered with the proxy's 502.

It does not cover a body too large for workerd's buffers that a Worker answers
without reading: workerd resets that connection while the body is still
arriving, and the answer can be lost before the proxy reads it. In a local
reproduction, 1 MB bodies lost the answer on 12 of 20 connections (16 of 20
before this patch).

`mcp-protocol-versions.spec.ts` sends its unknown-session request and the next
one on a single kept-alive connection and expects the next to be answered on
it; `patchGuards` in `e2e/ci-selection.ts` runs it whenever this patch
changes. `cloud-proxy-keep-alive.spec.ts` (`bun run e2e:cloud-proxy-keep-alive`,
in CI's `tooling` job) runs the patched proxy under Node and Bun in front of a
fake workerd: an early answer to a 32 MB upload that workerd stops reading, and
an answer the proxy cannot frame while it holds the next request. After
editing `src/core/proxy/KeepAlive.ts`, rebuild `dist/core/node/proxy/KeepAlive.mjs`
with `bun build src/core/proxy/KeepAlive.ts --no-bundle --target=node`, between
a `//#region src/core/proxy/KeepAlive.ts` line with the `node:net` import and
an `//#endregion` line. Drop this part when alchemy's proxy keeps the client's connection
itself.
