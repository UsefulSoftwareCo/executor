/** How images and audio in an execution result reach the MCP client. */
import { Option, Schema } from "effect";
import { McpSchema, type McpServer } from "effect/ai";

type MediaBlock = typeof McpSchema.ImageContent.Encoded | typeof McpSchema.AudioContent.Encoded;

const isImage = Schema.decodeUnknownOption(McpSchema.ImageContent);
const isAudio = Schema.decodeUnknownOption(McpSchema.AudioContent);

/**
 * Standard padded base64 for data in any common base64 form. Services and programs return base64url
 * (Gmail, JWTs), unpadded or line-wrapped data; MCP content takes only the standard form.
 */
const standardBase64 = (data: string) => {
  const compact = data.replaceAll(/\s/gu, "").replaceAll("-", "+").replaceAll("_", "/");
  return compact.length % 4 === 0
    ? compact
    : compact.padEnd(compact.length + 4 - (compact.length % 4), "=");
};

/** One MCP image or audio block whose data decodes as base64, with its data in the standard form. */
const mediaBlock = (value: unknown): MediaBlock | undefined => {
  if (typeof value !== "object" || value === null || !("type" in value)) return undefined;
  if (value.type !== "image" && value.type !== "audio") return undefined;
  if (!("data" in value) || typeof value.data !== "string") return undefined;
  const block = { ...value, data: standardBase64(value.data) };
  const valid =
    value.type === "image" ? Option.isSome(isImage(block)) : Option.isSome(isAudio(block));
  return valid ? (block as MediaBlock) : undefined;
};

/**
 * An execution result as JSON text and `structuredContent`, with each MCP image or audio block it
 * holds moved into its own content block. The JSON keeps `{ type, mimeType, contentIndex }` in its
 * place, the block's index in `content`, so the bytes reach the model as media instead of base64
 * text, once even when the result repeats them.
 */
export const executionResultContent: McpServer.ResultContent["Service"] = (encoded) => {
  const media: Array<MediaBlock> = [];
  const indexes = new Map<string, number>();
  const lift = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(lift);
    if (typeof value !== "object" || value === null) return value;
    const block = mediaBlock(value);
    if (block !== undefined) {
      const key = `${block.type}\0${block.mimeType}\0${block.data}`;
      let contentIndex = indexes.get(key);
      if (contentIndex === undefined) {
        media.push(block);
        contentIndex = media.length;
        indexes.set(key, contentIndex);
      }
      return { type: block.type, mimeType: block.mimeType, contentIndex };
    }
    return Object.fromEntries(Object.entries(value).map(([key, field]) => [key, lift(field)]));
  };
  const structured = lift(encoded) as typeof Schema.Json.Type;
  return {
    content: [{ type: "text", text: JSON.stringify(structured) }, ...media],
    structuredContent: structured,
  };
};
