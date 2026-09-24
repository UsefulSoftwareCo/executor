// Unit coverage for request routing in the Durable Object transport (see
// patches/agents@0.17.3.patch).
//
// Clients that pool one MCP session for many callers (each caller numbering
// its ids from 0) put the same JSON-RPC id on several POST streams at once. The
// transport used to pick the target stream by that id: it preferred the stream
// that carried the request only while that stream was still live. Once that
// caller had hung up, a late result went to the one other live stream holding
// the same id (a valid-looking answer to someone else's call), or, with two or
// more such streams, every one of them got `-32603 Internal error` and was
// closed.
//
// Pinned here against the real patched transport:
//   1. A late result never reaches another caller's stream that holds the same
//      id, and never errors that stream; it stays on its own stream.
//   2. A GET that resumed the originating stream (Last-Event-ID) still receives
//      the result, and the stream keeps its own id when the send runs under
//      that GET.
//   3. Related notifications and a batch's results stay on their own stream.
//   4. The async context is trusted only while its stream owns the id: a send
//      that runs under another stream's context still goes by id.
import { describe, expect, it } from "@effect/vitest";
import { __DO_NOT_USE_WILL_BREAK__agentContext as agentContext } from "agents";
import { McpAgent } from "agents/mcp";

type RequestId = number | string;

type FakeConnection = {
  readonly id: string;
  readonly state: { readonly streamId: string; readonly requestIds: RequestId[] };
  readonly sent: string[];
  readonly send: (message: string) => void;
};

const makeConnection = (
  id: string,
  requestIds: RequestId[],
  streamId: string = id,
): FakeConnection => {
  const sent: string[] = [];
  return { id, state: { streamId, requestIds }, sent, send: (message) => void sent.push(message) };
};

/** The `McpAgent` surface the transport touches, backed by plain maps. */
const makeAgent = (live: ReadonlyArray<FakeConnection>, rows: Map<string, RequestId[]>) => ({
  getSessionId: () => "session-1",
  getTransportType: () => "streamable-http",
  getEventStore: () => undefined,
  getConnections: () => live,
  getStreamRequestIds: async (streamId: string) => rows.get(streamId),
  getStreamForRequestId: async (requestId: RequestId) => {
    for (const [streamId, requestIds] of rows) {
      if (requestIds.includes(requestId)) return { streamId, requestIds };
    }
    return undefined;
  },
  deleteStreamRequestIds: async (streamId: string) => void rows.delete(streamId),
  markStreamUndelivered: async () => {},
  _handleElicitationResponse: () => false,
});

type FakeAgent = ReturnType<typeof makeAgent>;
type Transport = {
  readonly send: (message: unknown, options?: { relatedRequestId?: RequestId }) => Promise<void>;
};

const makeTransport = (agent: FakeAgent): Transport =>
  agentContext.run(
    { agent, connection: undefined, request: undefined, email: undefined } as never,
    () =>
      // oxlint-disable-next-line executor/no-double-cast -- test double: the transport class is not exported, so it is built through McpAgent's own initTransport on a fake agent
      (McpAgent.prototype as unknown as { initTransport: () => Transport }).initTransport.call(
        agent,
      ),
  );

/** Send `message` the way the MCP server does: inside the originating request's context. */
const sendFrom = (
  agent: FakeAgent,
  origin: FakeConnection,
  transport: Transport,
  message: unknown,
  relatedRequestId?: RequestId,
) =>
  agentContext.run(
    { agent, connection: origin, request: undefined, email: undefined } as never,
    () => transport.send(message, { relatedRequestId }),
  );

const result = (id: RequestId, text: string) => ({
  jsonrpc: "2.0" as const,
  id,
  result: { content: [{ type: "text", text }] },
});

const progress = (progressToken: RequestId) => ({
  jsonrpc: "2.0" as const,
  method: "notifications/progress",
  params: { progressToken, progress: 1 },
});

describe("DO transport: a response goes to the stream that carried its request", () => {
  it("keeps a late result off the one other live stream that reuses its id", async () => {
    const gone = makeConnection("gone", [0]);
    const waiting = makeConnection("waiting", [0]);
    const rows = new Map<string, RequestId[]>([
      ["gone", [0]],
      ["waiting", [0]],
    ]);
    const agent = makeAgent([waiting], rows);

    await sendFrom(agent, gone, makeTransport(agent), result(0, "gone's result"));

    expect(waiting.sent, "the waiting caller never sees another caller's result").toEqual([]);
    expect(rows.has("gone"), "the result closes out its own stream").toBe(false);
    expect(rows.has("waiting"), "the waiting caller is still owed its own answer").toBe(true);
  });

  it("does not error other live streams that reuse the id", async () => {
    const gone = makeConnection("gone", [0]);
    const waitingA = makeConnection("waiting-a", [0]);
    const waitingB = makeConnection("waiting-b", [0]);
    const rows = new Map<string, RequestId[]>([
      ["gone", [0]],
      ["waiting-a", [0]],
      ["waiting-b", [0]],
    ]);
    const agent = makeAgent([waitingA, waitingB], rows);

    await sendFrom(agent, gone, makeTransport(agent), result(0, "gone's result"));

    expect(waitingA.sent, "no -32603 for a request this stream did not make").toEqual([]);
    expect(waitingB.sent, "no -32603 for a request this stream did not make").toEqual([]);
    expect([...rows.keys()].sort(), "both waiting callers are still owed an answer").toEqual([
      "waiting-a",
      "waiting-b",
    ]);
  });

  it("delivers to a GET that resumed the originating stream", async () => {
    const post = makeConnection("post", [0]);
    const resumed = makeConnection("resumed-get", [0], "post");
    const other = makeConnection("other", [0]);
    const rows = new Map<string, RequestId[]>([
      ["post", [0]],
      ["other", [0]],
    ]);
    const agent = makeAgent([resumed, other], rows);

    await sendFrom(agent, post, makeTransport(agent), result(0, "post's result"));

    expect(resumed.sent, "the resumed stream receives its own result").toHaveLength(1);
    expect(resumed.sent[0]).toContain("post's result");
    expect(other.sent, "the other caller receives nothing").toEqual([]);
  });

  it("keeps the stream's own id when the send runs under the GET that resumed it", async () => {
    const resumed = makeConnection("resumed-get", [0], "post");
    const other = makeConnection("other", [0]);
    const rows = new Map<string, RequestId[]>([
      ["post", [0]],
      ["other", [0]],
    ]);
    const agent = makeAgent([resumed, other], rows);

    await sendFrom(agent, resumed, makeTransport(agent), result(0, "post's result"));

    expect(resumed.sent, "the resumed stream receives its own result").toHaveLength(1);
    expect(other.sent, "the other caller receives nothing").toEqual([]);
    expect(rows.has("post"), "the result closes out the original stream").toBe(false);
    expect(rows.has("other"), "the other caller is still owed its own answer").toBe(true);
  });

  it("keeps a batch's related notifications and results on its own stream", async () => {
    const batch = makeConnection("batch", [0, 1]);
    const other = makeConnection("other", [0]);
    const rows = new Map<string, RequestId[]>([
      ["batch", [0, 1]],
      ["other", [0]],
    ]);
    const agent = makeAgent([other], rows);
    const transport = makeTransport(agent);

    await sendFrom(agent, batch, transport, progress(0), 0);
    await sendFrom(agent, batch, transport, result(0, "batch's first result"));

    expect(other.sent, "the other caller sees neither message").toEqual([]);
    expect(rows.get("batch"), "the batch still owes its second answer").toEqual([0, 1]);
    expect(rows.has("other"), "the other caller is still owed its own answer").toBe(true);
  });

  it("routes by id when the send runs under a stream that does not own the id", async () => {
    const owner = makeConnection("owner", [7]);
    const bystander = makeConnection("bystander", [5]);
    const rows = new Map<string, RequestId[]>([
      ["owner", [7]],
      ["bystander", [5]],
    ]);
    const agent = makeAgent([owner, bystander], rows);

    await sendFrom(agent, bystander, makeTransport(agent), result(7, "owner's result"));

    expect(owner.sent, "the stream that holds id 7 receives it").toHaveLength(1);
    expect(owner.sent[0]).toContain("owner's result");
    expect(bystander.sent, "the stream in context does not own id 7").toEqual([]);
  });
});
