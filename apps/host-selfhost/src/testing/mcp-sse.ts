import { Schema } from "effect";

// Test helper: the MCP endpoint answers requests as streamable-HTTP SSE (so a
// native elicitation can ride a tool call's own stream), which puts the
// JSON-RPC response on a `data:` line instead of in a JSON body.

const decodeJson = Schema.decodeUnknownSync(Schema.UnknownFromJsonString);

/** Read the JSON-RPC response an MCP SSE answer carries. */
export const readJsonRpcResponse = async (response: Response): Promise<unknown> => {
  const data = (await response.text())
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim())
    .at(-1);
  return decodeJson(data ?? "");
};
