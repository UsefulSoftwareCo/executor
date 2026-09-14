// ---------------------------------------------------------------------------
// MCP tool results -> what Pi can put in front of a model.
//
// Pi's `AgentToolResult.content` is `(TextContent | ImageContent)[]`. There is
// no audio and no resource block, and — importantly — no error flag: the
// harness marks a call failed exactly when `execute` throws
// (pi-agent-core, harness/execution/tools.js). So an MCP `isError` result has
// to leave here as a thrown error carrying its text in the message, because
// the harness discards the content and keeps only the message.
// ---------------------------------------------------------------------------

import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { CallToolResult, ContentBlock } from "@modelcontextprotocol/sdk/types.js";

export type PiContent = TextContent | ImageContent;

const text = (value: string): TextContent => ({ type: "text", text: value });

/**
 * Executor already precedes every binary block with a `File output: name
 * (mime, bytes)` line (see `outputFileContent` in
 * packages/hosts/mcp/src/tool-server.ts), so dropping the payload costs the
 * bytes and nothing else: the model still knows the file exists and what it is.
 */
const omitted = (what: string): TextContent =>
  text(`[${what} omitted — Pi tool results carry text and images only]`);

const blockToPiContent = (block: ContentBlock): PiContent => {
  if (block.type === "text") return text(block.text);
  if (block.type === "image") return { type: "image", data: block.data, mimeType: block.mimeType };
  if (block.type === "audio") return omitted(`${block.mimeType} audio`);
  if (block.type === "resource_link") return omitted(`resource ${block.uri}`);
  // Text resources carry their content inline; binary ones carry a blob.
  if ("text" in block.resource && typeof block.resource.text === "string") {
    return text(block.resource.text);
  }
  return omitted(`resource ${block.resource.uri}`);
};

/** Flatten a result's text for a message the harness will keep. */
export const resultText = (result: CallToolResult): string =>
  result.content
    .filter((block): block is Extract<ContentBlock, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();

export const toPiContent = (result: CallToolResult): PiContent[] => {
  const content = result.content.map(blockToPiContent);
  return content.length > 0 ? content : [text("Executor returned no content.")];
};
