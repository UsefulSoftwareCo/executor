/** External real MCP transport. No application implementations or authority constructors. */
export const privateMcpHttp = (url: URL, token: string, organization: string) => {
  let session: string | undefined,
    id = 0;
  const observations: {
    method: string;
    status: number;
    contentType: string;
    readChunks?: number;
  }[] = [];
  const send = async (method: string, params: unknown, reference?: string): Promise<unknown> => {
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      "X-Executor-Organization": organization,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };
    if (session) {
      headers["mcp-session-id"] = session;
      headers["mcp-protocol-version"] = "2025-11-25";
    }
    if (reference) headers["Private-Invocation"] = reference;
    const notification = method.startsWith("notifications/"),
      requestId = notification ? undefined : ++id;
    const response = await fetch(url, {
      method: "POST",
      redirect: "error",
      headers,
      signal: AbortSignal.timeout(15000),
      body: JSON.stringify({
        jsonrpc: "2.0",
        ...(notification ? {} : { id: requestId }),
        method,
        params,
      }),
    });
    const observation = {
      method,
      status: response.status,
      contentType: response.headers.get("content-type") ?? "",
      readChunks: 0,
    };
    observations.push(observation);
    session ??= response.headers.get("mcp-session-id") ?? undefined;
    if (!response.ok) {
      await response.body?.cancel();
      return { refused: true };
    }
    if (notification) {
      await response.body?.cancel();
      return null;
    }
    if (!response.body) throw new Error("Missing MCP response");
    const reader = response.body.getReader(),
      decoder = new TextDecoder("utf-8", { fatal: true });
    let text = "",
      received = 0;
    const sse = (response.headers.get("content-type") ?? "").includes("text/event-stream");
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        observation.readChunks += 1;
        received += value.byteLength;
        if (received > 262144) throw new Error("MCP response exceeds evidence bound");
        text += decoder.decode(value, { stream: true });
        if (sse)
          for (;;) {
            const boundary = /\r?\n\r?\n/.exec(text);
            if (!boundary) break;
            const event = text.slice(0, boundary.index);
            text = text.slice(boundary.index + boundary[0].length);
            const data = event
              .split(/\r?\n/)
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).replace(/^ /, ""))
              .join("\n");
            if (!data) continue;
            const message = JSON.parse(data);
            if (message.id === requestId && ("result" in message || "error" in message))
              return message;
          }
      }
      text += decoder.decode();
      if (sse) throw new Error("MCP SSE ended without matching complete response");
      const message = JSON.parse(text);
      if (message.id !== requestId || !("result" in message || "error" in message))
        throw new Error("MCP response ID mismatch");
      return message;
    } finally {
      await reader.cancel();
    }
  };
  return {
    send,
    observations,
    get session() {
      return session;
    },
    close: async () => {
      if (session)
        await fetch(url, {
          method: "DELETE",
          redirect: "error",
          headers: {
            authorization: `Bearer ${token}`,
            "X-Executor-Organization": organization,
            "mcp-session-id": session,
          },
          signal: AbortSignal.timeout(5000),
        })
          .then((r) => r.body?.cancel())
          .catch(() => {});
    },
  };
};
