/** How images, audio and files in an execution result reach the MCP client. */
import { Option, Schema } from "effect";
import { McpSchema, type McpServer } from "effect/ai";

type BlobResource = typeof McpSchema.EmbeddedResource.Encoded & {
  readonly resource: typeof McpSchema.BlobResourceContents.Encoded;
};
type MediaBlock =
  | typeof McpSchema.ImageContent.Encoded
  | typeof McpSchema.AudioContent.Encoded
  | BlobResource;

const isImage = Schema.decodeUnknownOption(McpSchema.ImageContent);
const isAudio = Schema.decodeUnknownOption(McpSchema.AudioContent);
const isBlobResource = Schema.decodeUnknownOption(
  Schema.Struct({ type: Schema.Literal("resource"), resource: McpSchema.BlobResourceContents }),
);

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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** One media block, the key that identifies its bytes, and what the JSON keeps in its place. */
interface Lifted {
  readonly block: MediaBlock;
  readonly key: string;
  readonly placeholder: (contentIndex: number) => Record<string, unknown>;
}

/**
 * An MCP image or audio block, or an embedded resource holding a blob, whose data decodes as
 * base64, with its data in the standard form. A text resource is already readable and stays in the
 * JSON.
 */
const mediaBlock = (value: Record<string, unknown>): Lifted | undefined => {
  if ((value.type === "image" || value.type === "audio") && typeof value.data === "string") {
    const block = { ...value, data: standardBase64(value.data) };
    const valid =
      value.type === "image" ? Option.isSome(isImage(block)) : Option.isSome(isAudio(block));
    if (!valid) return undefined;
    const media = block as typeof McpSchema.ImageContent.Encoded;
    return {
      block: media,
      key: `${media.type}\0${media.mimeType}\0${media.data}`,
      placeholder: (contentIndex) => ({ type: media.type, mimeType: media.mimeType, contentIndex }),
    };
  }
  if (value.type !== "resource" || !isRecord(value.resource)) return undefined;
  const { blob } = value.resource;
  if (typeof blob !== "string") return undefined;
  const block = { ...value, resource: { ...value.resource, blob: standardBase64(blob) } };
  if (Option.isNone(isBlobResource(block))) return undefined;
  const { uri, mimeType } = (block as BlobResource).resource;
  const described = mimeType === undefined ? { uri } : { uri, mimeType };
  return {
    block: block as BlobResource,
    key: `resource\0${uri}\0${mimeType ?? ""}\0${block.resource.blob}`,
    placeholder: (contentIndex) => ({ type: "resource", resource: described, contentIndex }),
  };
};

/**
 * An execution result as JSON text and `structuredContent`, with each MCP image, audio or blob
 * resource block it holds moved into its own content block. The JSON keeps the block without its
 * bytes, plus `contentIndex`, the block's index in `content`, so the bytes reach the client as
 * media or a file instead of base64 text, once even when the result repeats them.
 */
export const executionResultContent: McpServer.ResultContent["Service"] = (encoded) => {
  const media: Array<MediaBlock> = [];
  const indexes = new Map<string, number>();
  const lift = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(lift);
    if (!isRecord(value)) return value;
    const lifted = mediaBlock(value);
    if (lifted !== undefined) {
      let contentIndex = indexes.get(lifted.key);
      if (contentIndex === undefined) {
        media.push(lifted.block);
        contentIndex = media.length;
        indexes.set(lifted.key, contentIndex);
      }
      return lifted.placeholder(contentIndex);
    }
    return Object.fromEntries(Object.entries(value).map(([key, field]) => [key, lift(field)]));
  };
  const structured = lift(encoded) as typeof Schema.Json.Type;
  return {
    content: [{ type: "text", text: JSON.stringify(structured) }, ...media],
    structuredContent: structured,
  };
};
