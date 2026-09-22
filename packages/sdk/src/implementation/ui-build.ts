/** Shared HTML planning and output checks for Node and Worker browser compilers. */
import { Effect, Path, Schema } from "effect";
import { parse, serialize, type DefaultTreeAdapterMap } from "parse5";
import { SourceFilePath, type SourceFiles } from "../contracts/deployment.ts";
import { RuntimeBuildFailed } from "../contracts/runtime.ts";
import type { UiBuildFile, UiBuildPlan } from "../contracts/ui-build.ts";

type Element = DefaultTreeAdapterMap["element"];
const elements = (node: DefaultTreeAdapterMap["node"]): Element[] => [
  ...("tagName" in node ? [node] : []),
  ...("childNodes" in node ? node.childNodes.flatMap(elements) : []),
];
const failed = () => new RuntimeBuildFailed({ stage: "compile" });
const browserExports = new Set(["apps", "apps/client", "apps/effect", "apps/react"]);

/** Only these framework subpaths are browser APIs. */
export const isBrowserAppImport = (specifier: string) => browserExports.has(specifier);
/** Authored server implementation cannot enter the executable browser graph. */
export const isServerUiImport = (path: string) => path === "index.ts" || path.startsWith("server/");
/** Content types for the text-source and compiler-generated asset formats supported today. */
export const uiContentType = (file: string) =>
  file.endsWith(".js")
    ? "text/javascript"
    : file.endsWith(".css")
      ? "text/css"
      : file.endsWith(".svg")
        ? "image/svg+xml"
        : file.endsWith(".json") || file.endsWith(".map")
          ? "application/json"
          : file.endsWith(".woff2")
            ? "font/woff2"
            : "text/plain";

/** Discover module/style entries without evaluating server code; finish preserves public files and the host context marker. */
export const prepareUiBuild = (
  files: SourceFiles,
): Effect.Effect<UiBuildPlan | undefined, RuntimeBuildFailed> =>
  Effect.gen(function* () {
    const entry = files.find((file) => file.path === "ui/index.html");
    if (entry === undefined) return undefined;
    const path = yield* Path.Path;
    const document = parse(entry.content);
    const entries: Array<{ element: Element; attribute: string; source: string }> = [];
    for (const element of elements(document)) {
      const attribute =
        element.tagName === "script" &&
        element.attrs.some((a) => a.name === "type" && a.value === "module")
          ? "src"
          : element.tagName === "link" &&
              element.attrs.some((a) => a.name === "rel" && a.value === "stylesheet")
            ? "href"
            : undefined;
      const value = element.attrs.find((a) => a.name === attribute)?.value;
      if (attribute === undefined || value === undefined || /^(?:https?:|\/\/|data:)/.test(value))
        continue;
      const location = path.resolve("/ui", value.replace(/^\//, ""));
      if (!location.startsWith("/ui/") || !files.some((file) => file.path === location.slice(1)))
        return yield* failed();
      entries.push({ element, attribute, source: location.slice(1) });
    }
    return {
      html: entry.content,
      entries: [...new Set(entries.map((entry) => entry.source))],
      finish: (compiled, outputs) =>
        Effect.gen(function* () {
          const assets = new Map<string, UiBuildFile>();
          for (const file of compiled) {
            yield* Schema.decodeUnknownEffect(SourceFilePath)(file.path);
            if (file.path === "index.html" || file.path.startsWith("_executor/"))
              return yield* failed();
            const previous = assets.get(file.path);
            if (
              previous !== undefined &&
              (previous.contentType !== file.contentType ||
                previous.body.length !== file.body.length ||
                !previous.body.every((byte, i) => byte === file.body[i]))
            )
              return yield* failed();
            assets.set(file.path, file);
          }
          const head = elements(document).find((element) => element.tagName === "head");
          for (const entry of entries) {
            const emitted = outputs.find((output) => output.source === entry.source);
            if (emitted === undefined || !assets.has(emitted.path)) return yield* failed();
            const attribute = entry.element.attrs.find(
              (attribute) => attribute.name === entry.attribute,
            );
            if (attribute !== undefined) attribute.value = emitted.path;
            if (emitted.css !== undefined && head !== undefined) {
              if (!assets.has(emitted.css)) return yield* failed();
              const link: Element = {
                nodeName: "link",
                tagName: "link",
                namespaceURI: head.namespaceURI,
                attrs: [
                  { name: "rel", value: "stylesheet" },
                  { name: "href", value: emitted.css },
                ],
                childNodes: [],
                parentNode: head,
              };
              head.childNodes.push(link);
            }
          }
          if (head !== undefined) {
            head.childNodes = head.childNodes.filter(
              (node) => !("tagName" in node && node.tagName === "base"),
            );
            head.childNodes.unshift({
              nodeName: "#comment",
              data: "executor-ui",
              parentNode: head,
            });
          }
          assets.set("index.html", {
            path: "index.html",
            contentType: "text/html",
            body: new TextEncoder().encode(serialize(document)),
          });
          for (const file of files.filter((file) => file.path.startsWith("ui/public/"))) {
            const relative = yield* Schema.decodeUnknownEffect(SourceFilePath)(
              file.path.slice("ui/public/".length),
            );
            if (assets.has(relative) || relative.startsWith("_executor/")) return yield* failed();
            assets.set(relative, {
              path: relative,
              body: new TextEncoder().encode(file.content),
              contentType: uiContentType(relative),
            });
          }
          return [...assets.values()];
        }).pipe(Effect.mapError(failed)),
    } satisfies UiBuildPlan;
  }).pipe(Effect.provide(Path.layer), Effect.mapError(failed));
