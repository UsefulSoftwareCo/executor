import { describe, expect, it } from "@effect/vitest";
import { Effect, Encoding, Layer, Option } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import { recoverSlackConnectFile } from "./slack-connect-file";

const ACCESS_TOKEN = "xoxp-test-token";
const FILE_ID = "F012ABC3456";
const IMAGE_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

const httpClientLayer = (
  respond: (request: Request) => Response,
): Layer.Layer<HttpClient.HttpClient> =>
  Layer.succeed(HttpClient.HttpClient)(
    HttpClient.make((request: HttpClientRequest.HttpClientRequest) => {
      const url = new URL(request.url);
      for (const [name, value] of request.urlParams) url.searchParams.append(name, value);
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          respond(new Request(url, { method: request.method, headers: request.headers })),
        ),
      );
    }),
  );

const recover = (
  layer: Layer.Layer<HttpClient.HttpClient>,
  overrides: Partial<Parameters<typeof recoverSlackConnectFile>[0]> = {},
) =>
  recoverSlackConnectFile({
    endpoint: "https://mcp.slack.com/mcp",
    toolName: "slack_read_file",
    args: { file_id: FILE_ID },
    accessToken: ACCESS_TOKEN,
    upstreamErrorMessage: "execution_failed: file_not_found",
    ...overrides,
  }).pipe(Effect.provide(layer));

describe("recoverSlackConnectFile", () => {
  it.effect("resolves and downloads a Slack Connect image with the existing OAuth token", () =>
    Effect.gen(function* () {
      const requests: Request[] = [];
      const layer = httpClientLayer((request) => {
        requests.push(request);
        const url = new URL(request.url);
        if (url.hostname === "slack.com") {
          return Response.json({
            ok: true,
            file: {
              id: FILE_ID,
              name: "screenshot.png",
              title: "screenshot.png",
              mimetype: "image/png",
              size: IMAGE_BYTES.byteLength,
              url_private_download: `https://files.slack.com/files-pri/T000-${FILE_ID}/download/screenshot.png`,
            },
          });
        }
        return new Response(IMAGE_BYTES, {
          status: 200,
          headers: { "content-type": "image/png" },
        });
      });

      const result = yield* recover(layer);

      expect(Option.isSome(result)).toBe(true);
      const recovered = Option.getOrThrow(result);
      expect(recovered.content).toEqual([
        {
          type: "text",
          text: `File ID: ${FILE_ID}\nTitle: screenshot.png\nMIME Type: image/png\nSize: 8 bytes\n`,
        },
        {
          type: "image",
          data: Encoding.encodeBase64(IMAGE_BYTES),
          mimeType: "image/png",
        },
      ]);
      expect(requests).toHaveLength(2);
      expect(requests.map((request) => new URL(request.url).searchParams.get("file"))).toEqual([
        FILE_ID,
        null,
      ]);
      expect(requests.map((request) => request.headers.get("authorization"))).toEqual([
        `Bearer ${ACCESS_TOKEN}`,
        `Bearer ${ACCESS_TOKEN}`,
      ]);
    }),
  );

  it.effect("does not call Slack for unrelated MCP failures", () =>
    Effect.gen(function* () {
      let requestCount = 0;
      const layer = httpClientLayer(() => {
        requestCount += 1;
        return new Response("unexpected", { status: 500 });
      });

      const results = yield* Effect.all([
        recover(layer, { endpoint: "https://example.com/mcp" }),
        recover(layer, { toolName: "another_tool" }),
        recover(layer, { upstreamErrorMessage: "execution_failed: permission_denied" }),
        recover(layer, { accessToken: null }),
        recover(layer, { args: { file_id: "../not-a-file-id" } }),
      ]);

      expect(results.every(Option.isNone)).toBe(true);
      expect(requestCount).toBe(0);
    }),
  );

  it.effect("rejects non-image and untrusted download responses", () =>
    Effect.gen(function* () {
      const nonImage = yield* recover(
        httpClientLayer(() =>
          Response.json({
            ok: true,
            file: {
              id: FILE_ID,
              name: "notes.txt",
              mimetype: "text/plain",
              size: 10,
              url_private_download: "https://files.slack.com/files-pri/file",
            },
          }),
        ),
      );
      const untrusted = yield* recover(
        httpClientLayer(() =>
          Response.json({
            ok: true,
            file: {
              id: FILE_ID,
              name: "screenshot.png",
              mimetype: "image/png",
              size: 10,
              url_private_download: "https://example.com/screenshot.png",
            },
          }),
        ),
      );
      let requestCount = 0;
      const wrongResponseType = yield* recover(
        httpClientLayer(() => {
          requestCount += 1;
          return requestCount === 1
            ? Response.json({
                ok: true,
                file: {
                  id: FILE_ID,
                  name: "screenshot.png",
                  mimetype: "image/png",
                  size: 10,
                  url_private_download: "https://files.slack.com/files-pri/file",
                },
              })
            : new Response("not an image", {
                status: 200,
                headers: { "content-type": "text/html" },
              });
        }),
      );

      expect(Option.isNone(nonImage)).toBe(true);
      expect(Option.isNone(untrusted)).toBe(true);
      expect(Option.isNone(wrongResponseType)).toBe(true);
    }),
  );
});
