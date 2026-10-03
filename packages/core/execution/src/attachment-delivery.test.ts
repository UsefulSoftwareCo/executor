import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { makeQuickJsExecutor } from "@executor-js/runtime-quickjs";
import { withAttachmentDelivery } from "./attachment-delivery";

const image = { type: "image", mimeType: "image/gif", data: "R0lGODlh" };
const video = {
  type: "resource",
  resource: { uri: "https://slides.example/slides.mp4", mimeType: "video/mp4", blob: "AAAA" },
};

const run = (value: unknown, code: string) => {
  const delivery = withAttachmentDelivery({ invoke: () => Effect.succeed(value) });
  return makeQuickJsExecutor().execute(code, delivery.invoker).pipe(Effect.map(delivery.finish));
};

describe("native attachment delivery", () => {
  it.effect("delivers every MCP attachment without emit or a download", () =>
    Effect.gen(function* () {
      const result = yield* run(
        { ok: true, data: { content: [image, video], structuredContent: { render_id: "abc" } } },
        "return await tools.slides.org.main.render({});",
      );
      expect(result.output).toEqual([
        { type: "content", content: image },
        { type: "content", content: video },
      ]);
      expect(JSON.stringify(result.result)).not.toContain(image.data);
      expect(JSON.stringify(result.result)).not.toContain(video.resource.blob);
      expect(result.result).toMatchObject({
        ok: true,
        data: { structuredContent: { render_id: "abc" } },
      });
    }),
  );

  it.effect("delivers files even when the script returns only metadata", () =>
    Effect.gen(function* () {
      const file = {
        _tag: "ToolFile",
        encoding: "base64",
        name: "report.pdf",
        mimeType: "application/pdf",
        data: "JVBERg==",
        byteLength: 4,
      };
      const result = yield* run(
        { ok: true, data: file },
        "await tools.reports.org.main.get({}); return {done:true};",
      );
      expect(result.output).toEqual([{ type: "file", file }]);
      expect(result.result).toEqual({ done: true });
    }),
  );

  it.effect("preserves explicit output order without duplicate attachments", () =>
    Effect.gen(function* () {
      const result = yield* run(
        { ok: true, data: { content: [image] } },
        'const r = await tools.slides.org.main.render({}); emit({type:"text",text:"caption"}); emit(r.data.content[0]); return r;',
      );
      expect(result.output).toEqual([
        { type: "content", content: { type: "text", text: "caption" } },
        { type: "content", content: image },
      ]);
    }),
  );

  it.effect("keeps attachment bytes available for tool-to-tool uploads", () =>
    Effect.gen(function* () {
      const result = yield* run(
        { ok: true, data: { content: [image] } },
        "const r = await tools.slides.org.main.render({}); return {bytesAvailable: r.data.content[0].data === 'R0lGODlh'};",
      );
      expect(result.result).toEqual({ bytesAvailable: true });
    }),
  );

  it.effect("does not deliver failed tool results", () =>
    Effect.gen(function* () {
      for (const value of [
        { ok: false, error: { content: [image] } },
        { ok: true, data: { isError: true, content: [image] } },
      ]) {
        const result = yield* run(value, "return await tools.slides.org.main.render({});");
        expect(result.output ?? []).toEqual([]);
        expect(JSON.stringify(result.result)).not.toContain(image.data);
      }
    }),
  );

  it.effect("keeps successful attachments when a later script step fails", () =>
    Effect.gen(function* () {
      const result = yield* run(
        { ok: true, data: { content: [image] } },
        "await tools.slides.org.main.render({}); throw new Error('later');",
      );
      expect(result.error).toContain("later");
      expect(result.output).toEqual([{ type: "content", content: image }]);
    }),
  );

  it.effect("preserves ordinary text and resource links", () =>
    Effect.gen(function* () {
      const value = {
        ok: true,
        data: {
          content: [
            { type: "text", text: "hello" },
            { type: "resource_link", uri: "https://example.com", name: "report" },
          ],
        },
      };
      const result = yield* run(value, "return await tools.slides.org.main.render({});");
      expect(result.result).toEqual(value);
      expect(result.output).toBeUndefined();
    }),
  );
});
