import { Effect, Encoding, Option, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

const SLACK_MCP_HOST = "mcp.slack.com";
const SLACK_MCP_PATH = "/mcp";
const SLACK_FILE_INFO_URL = "https://slack.com/api/files.info";
const SLACK_FILE_HOST = "files.slack.com";
const MAX_SLACK_FILE_BYTES = 10 * 1024 * 1024;

const SlackReadFileArgs = Schema.Struct({ file_id: Schema.String });
const decodeSlackReadFileArgs = Schema.decodeUnknownOption(SlackReadFileArgs);

const SlackFileInfo = Schema.Struct({
  id: Schema.String,
  name: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  mimetype: Schema.String,
  size: Schema.Number,
  url_private: Schema.optional(Schema.String),
  url_private_download: Schema.optional(Schema.String),
});

const SlackFileInfoSuccess = Schema.Struct({
  ok: Schema.Literal(true),
  file: SlackFileInfo,
});
const decodeSlackFileInfoSuccess = Schema.decodeUnknownOption(SlackFileInfoSuccess);

const parseUrl = Option.liftThrowable((value: string) => new URL(value));

const isSlackMcpEndpoint = (value: string): boolean =>
  Option.match(parseUrl(value), {
    onNone: () => false,
    onSome: (url) =>
      url.protocol === "https:" &&
      url.hostname === SLACK_MCP_HOST &&
      url.pathname.replace(/\/$/, "") === SLACK_MCP_PATH,
  });

const trustedSlackFileUrl = (value: string): URL | null =>
  Option.match(parseUrl(value), {
    onNone: () => null,
    onSome: (url) => (url.protocol === "https:" && url.hostname === SLACK_FILE_HOST ? url : null),
  });

const bearerHeaders = (accessToken: string): Readonly<Record<string, string>> => ({
  Authorization: `Bearer ${accessToken}`,
});

const safeTitle = (value: string): string => value.replace(/[\r\n]/g, " ");

type SlackImageToolResult = {
  readonly content: readonly [
    { readonly type: "text"; readonly text: string },
    { readonly type: "image"; readonly data: string; readonly mimeType: string },
  ];
};

interface RecoverSlackConnectFileInput {
  readonly endpoint: string;
  readonly toolName: string;
  readonly args: unknown;
  readonly accessToken: string | null;
  readonly upstreamErrorMessage: string;
}

/**
 * Recovers Slack Connect images that Slack's hosted MCP server reports as
 * `file_not_found` by resolving the file through Slack's Web API with the same
 * user OAuth grant. Returns `None` for non-Slack calls and for any fallback
 * failure so the caller can preserve the original upstream error.
 */
export const recoverSlackConnectFile = (
  input: RecoverSlackConnectFileInput,
): Effect.Effect<Option.Option<SlackImageToolResult>, never, HttpClient.HttpClient> => {
  if (
    input.toolName !== "slack_read_file" ||
    !input.upstreamErrorMessage.includes("file_not_found") ||
    !isSlackMcpEndpoint(input.endpoint) ||
    input.accessToken === null ||
    input.accessToken.length === 0
  ) {
    return Effect.succeed(Option.none());
  }
  const accessToken = input.accessToken;

  const args = Option.getOrUndefined(decodeSlackReadFileArgs(input.args));
  const fileId = args?.file_id.trim();
  if (fileId === undefined || !/^F[A-Z0-9]+$/.test(fileId)) {
    return Effect.succeed(Option.none());
  }

  return Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const infoUrl = new URL(SLACK_FILE_INFO_URL);
    infoUrl.searchParams.set("file", fileId);

    const infoResponse = yield* client.execute(
      HttpClientRequest.get(infoUrl, { headers: bearerHeaders(accessToken) }),
    );
    if (infoResponse.status < 200 || infoResponse.status >= 300) return Option.none();

    const info = Option.getOrUndefined(decodeSlackFileInfoSuccess(yield* infoResponse.json));
    if (
      info === undefined ||
      !info.file.mimetype.startsWith("image/") ||
      !Number.isSafeInteger(info.file.size) ||
      info.file.size < 0 ||
      info.file.size > MAX_SLACK_FILE_BYTES
    ) {
      return Option.none();
    }

    const downloadUrl = trustedSlackFileUrl(
      info.file.url_private_download ?? info.file.url_private ?? "",
    );
    if (downloadUrl === null) return Option.none();

    const downloadResponse = yield* client.execute(
      HttpClientRequest.get(downloadUrl, { headers: bearerHeaders(accessToken) }),
    );
    if (downloadResponse.status < 200 || downloadResponse.status >= 300) return Option.none();
    const responseMimeType = downloadResponse.headers["content-type"]
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase();
    if (responseMimeType !== undefined && !responseMimeType.startsWith("image/")) {
      return Option.none();
    }

    const bytes = new Uint8Array(yield* downloadResponse.arrayBuffer);
    if (bytes.byteLength > MAX_SLACK_FILE_BYTES) return Option.none();

    const title = safeTitle(info.file.title ?? info.file.name ?? info.file.id);
    const recovered: SlackImageToolResult = {
      content: [
        {
          type: "text",
          text: `File ID: ${info.file.id}\nTitle: ${title}\nMIME Type: ${info.file.mimetype}\nSize: ${info.file.size} bytes\n`,
        },
        {
          type: "image",
          data: Encoding.encodeBase64(bytes),
          mimeType: info.file.mimetype,
        },
      ],
    };
    return Option.some(recovered);
  }).pipe(
    Effect.catch(() => Effect.succeed(Option.none())),
    Effect.withSpan("plugin.mcp.slack_connect_file_fallback"),
  );
};
