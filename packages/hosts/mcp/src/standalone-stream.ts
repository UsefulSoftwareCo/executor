import type { ClientCapabilities } from "@modelcontextprotocol/sdk/types.js";
import { getUiCapability, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";

// ---------------------------------------------------------------------------
// Whether a session's standalone `GET /mcp` stream can ever carry anything.
//
// The standalone SSE stream exists for server-initiated messages: requests the
// server makes of the client (elicitation, sampling, roots) and notifications
// such as a tool-list change when the MCP Apps capability toggles a tool. A
// client that negotiated none of those capabilities can never receive any of
// them, so the stream it opens stays silent for the life of the session. The
// streamable-HTTP spec lets a server answer that GET with 405 instead of
// offering a stream, and the client SDKs read 405 as "no stream here" and
// move on. Answering 405 saves such clients a request and the server an open
// stream per session — which matters for a gateway that opens a fresh session
// for every tool call.
//
// Capabilities arrive with `initialize`. Before that, or for any client that
// declared one of the capabilities above, the stream is offered as before.
// ---------------------------------------------------------------------------

type ClientCapabilitiesWithExtensions = ClientCapabilities & {
  readonly extensions?: Record<string, unknown>;
};

export const serverInitiatedMessagesPossible = (
  capabilities: ClientCapabilities | undefined,
): boolean => {
  if (!capabilities) return true;
  if (capabilities.elicitation || capabilities.sampling || capabilities.roots) return true;
  const ui = getUiCapability(capabilities as ClientCapabilitiesWithExtensions);
  return Boolean(ui?.mimeTypes?.includes(RESOURCE_MIME_TYPE));
};

/** The 405 a session answers its standalone GET with when no server-initiated
 *  message can ever reach this client. An inner response: the envelope adds
 *  CORS. `allow` names what the endpoint still serves. */
export const standaloneStreamNotOffered = (): Response =>
  new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message:
          "Standalone SSE stream not offered: the negotiated client capabilities admit no server-initiated messages",
      },
      id: null,
    }),
    { status: 405, headers: { "content-type": "application/json", allow: "POST, DELETE" } },
  );
