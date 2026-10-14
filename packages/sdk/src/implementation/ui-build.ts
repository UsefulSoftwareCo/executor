/** Shared HTML planning and output checks for Node and Worker browser compilers. */
import { Effect, Path, Schema } from "effect";
import { parse, serialize, type DefaultTreeAdapterMap } from "parse5";
import { SourceFilePath } from "../contracts/deployment.ts";
import type { CodeFiles } from "../contracts/source.ts";
import { publicFileContentType } from "../contracts/public-files.ts";
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
/** Content types for compiled output, from the same table public files are served with. */
export const uiContentType = (file: string) => publicFileContentType(file, "text/plain");

/** A compiled file and a public file claim one path. */
class PublicPathTaken extends Schema.TaggedError<PublicPathTaken>()("PublicPathTaken", {
  path: Schema.String,
}) {}

/**
 * Discover module/style entries without evaluating server code; finish adds the host context
 * marker. `publicPaths` are the public files served beside the build, relative to `ui/public/`:
 * the page may reference them as they are, and no compiled file may take one of their paths.
 */
export const prepareUiBuild = (
  files: CodeFiles,
  publicPaths: ReadonlyArray<string> = [],
): Effect.Effect<UiBuildPlan | undefined, RuntimeBuildFailed> =>
  Effect.gen(function* () {
    const entry = files.find((file) => file.path === "ui/index.html");
    if (entry === undefined) return undefined;
    const path = yield* Path.Path;
    const document = parse(entry.content);
    const served = new Set(publicPaths);
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
      if (!location.startsWith("/ui/")) return yield* failed();
      if (!files.some((file) => file.path === location.slice(1))) {
        // A prebuilt script or stylesheet among the public files is served as it is.
        if (served.has(location.slice("/ui/".length))) continue;
        return yield* failed();
      }
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
          const taken = [...assets.keys()].find((path) => served.has(path));
          if (taken !== undefined) return yield* new PublicPathTaken({ path: taken });
          return [...assets.values()];
        }).pipe(
          Effect.catchTag("PublicPathTaken", ({ path }) =>
            Effect.fail(
              new RuntimeBuildFailed({
                stage: "compile",
                location: { file: `ui/public/${path}` },
                message: `ui/public/${path} has the same path as a file the browser build produced. Rename it.`,
              }),
            ),
          ),
          Effect.mapError((error) => (Schema.is(RuntimeBuildFailed)(error) ? error : failed())),
        ),
    } satisfies UiBuildPlan;
  }).pipe(
    Effect.provide(Path.layer),
    Effect.mapError((error) => (Schema.is(RuntimeBuildFailed)(error) ? error : failed())),
  );
