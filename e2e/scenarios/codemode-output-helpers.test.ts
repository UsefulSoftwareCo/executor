import { expect } from "@effect/vitest";
import { Effect } from "effect";

import { scenario } from "../src/scenario";
import { Mcp, Target } from "../src/services";

const PNG_DATA =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";
const PNG_DATA_URL = `data:image/png;base64,${PNG_DATA}`;

scenario(
  "Codemode · output helpers emit images, detail metadata, and notifications",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const mcp = yield* Mcp;
    const identity = yield* target.newIdentity();
    const session = mcp.session(identity);

    const result = yield* session.call("execute", {
      code: [
        'text("helper caption");',
        `image(${JSON.stringify(PNG_DATA_URL)}, "original");`,
        `image({ image_url: ${JSON.stringify(PNG_DATA_URL)}, detail: "low" });`,
        'notify({ message: "rendered previews", data: { count: 2 } });',
        "return {",
        '  value: "structured return",',
        "  toolKeys: {",
        "    root: Object.keys(tools),",
        "    describe: Object.keys(tools.describe),",
        "    executor: Object.keys(tools.executor),",
        "    sources: Object.keys(tools.executor.sources),",
        "  },",
        "};",
      ].join("\n"),
    });

    expect(result.ok, `execute completed (got: ${result.text.slice(0, 300)})`).toBe(true);

    const raw = result.raw as {
      content?: ReadonlyArray<Record<string, unknown>>;
      structuredContent?: Record<string, unknown>;
    };
    const content = raw.content ?? [];
    expect(result.text, "text() reaches the user-visible MCP text stream").toContain(
      "helper caption",
    );
    expect(result.text, "notify() renders as a distinct visible notification").toContain(
      "Notification: rendered previews",
    );

    const images = content.filter((block) => block.type === "image");
    expect(images, "image() emits two MCP image blocks").toHaveLength(2);
    expect(images[0], "data URI image is converted to MCP image content").toMatchObject({
      type: "image",
      data: PNG_DATA,
      mimeType: "image/png",
      _meta: { "codex/imageDetail": "original" },
    });
    expect(images[1], "image_url object detail is preserved").toMatchObject({
      type: "image",
      data: PNG_DATA,
      mimeType: "image/png",
      _meta: { "codex/imageDetail": "low" },
    });

    expect(raw.structuredContent?.result, "return value stays model-visible").toEqual({
      value: "structured return",
      toolKeys: {
        root: ["search", "describe", "executor"],
        describe: ["tool"],
        executor: ["sources"],
        sources: ["list"],
      },
    });
    expect(raw.structuredContent?.notifications, "notifications are structured too").toEqual([
      { message: "rendered previews", data: { count: 2 } },
    ]);
  }),
);
