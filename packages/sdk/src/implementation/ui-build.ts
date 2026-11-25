import { Effect, Path, Result, Schema } from "effect";
import { parse, serialize, type DefaultTreeAdapterMap } from "parse5";
import { SaxesParser } from "saxes";
import {
  appUiDocuments,
  appUiIcon,
  appUiIconMaxBytes,
  AppUiPagesManifest,
  appUiPagesAsset,
  type AppUiDocument,
} from "apps/ui/contracts";
import { SourceFilePath } from "../contracts/version.ts";
import type { CodeFiles } from "../contracts/source.ts";
import { publicFileContentType } from "../contracts/public-files.ts";
import { RuntimeBuildFailed } from "../contracts/runtime.ts";
import type { UiBuildEntry, UiBuildFile, UiBuildPlan } from "../contracts/ui-build.ts";

type Element = DefaultTreeAdapterMap["element"];
const elements = (node: DefaultTreeAdapterMap["node"]): Element[] => [
  ...("tagName" in node ? [node] : []),
  ...("childNodes" in node ? node.childNodes.flatMap(elements) : []),
];
const failed = () => new RuntimeBuildFailed({ stage: "compile" });
const browserExports = new Set(["apps", "apps/client", "apps/effect", "apps/react"]);

export const isBrowserAppImport = (specifier: string) => browserExports.has(specifier);
export const isServerUiImport = (path: string) => path === "index.ts" || path.startsWith("server/");
export const uiContentType = (file: string) => publicFileContentType(file, "text/plain");

class PublicPathTaken extends Schema.TaggedError<PublicPathTaken>()("PublicPathTaken", {
  path: Schema.String,
}) {}

type Plan = {
  readonly kind: AppUiDocument;
  readonly html: string;
  readonly document: DefaultTreeAdapterMap["document"];
  readonly entries: ReadonlyArray<{
    readonly element: Element;
    readonly attribute: string;
    readonly source: string;
  }>;
};

const planDocument = (
  kind: AppUiDocument,
  html: string,
  files: CodeFiles,
  served: ReadonlySet<string>,
) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const document = parse(html);
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
        if (served.has(location.slice("/ui/".length))) continue;
        return yield* failed();
      }
      entries.push({ element, attribute, source: location.slice(1) });
    }
    return { kind, html, document, entries } satisfies Plan;
  });

const sourceFailure = (file: string, message: string) =>
  new RuntimeBuildFailed({ stage: "source", location: { file }, message });

const svgNamespace = "http://www.w3.org/2000/svg";
const shapeRequired = `${appUiIcon.source} must contain one <svg xmlns="${svgNamespace}"> element.`;

const iconProblem = (content: string): string | undefined => {
  let doctype = /<!(?:DOCTYPE|ENTITY)/iu.test(content);
  let malformed: string | undefined;
  let root: boolean | undefined;
  let instruction: string | undefined;
  let element: string | undefined;
  const parser = new SaxesParser({ xmlns: true });
  parser.on("error", (error) => {
    malformed ??= (error.message.split("\n")[0] ?? error.message).replace(/\.$/u, "");
  });
  parser.on("doctype", () => {
    doctype = true;
  });
  parser.on("processinginstruction", (found) => {
    instruction ??= found.target;
  });
  parser.on("opentag", (tag) => {
    if (root === undefined)
      root =
        tag.local === "svg" &&
        tag.uri === svgNamespace &&
        tag.attributes.xmlns?.value === svgNamespace;
    if (element !== undefined) return;
    const name = tag.local.toLowerCase();
    if (name === "script" || name === "foreignobject") {
      element = `${appUiIcon.source} has a <${tag.name}> element. Remove it; an icon can't run scripts or embed other content.`;
      return;
    }
    for (const attribute of Object.values(tag.attributes)) {
      const attributeName = attribute.local.toLowerCase();
      if (attributeName.startsWith("on")) {
        element = `${appUiIcon.source} has an ${attribute.name} attribute on <${tag.name}>. Remove it; an icon can't run scripts.`;
        return;
      }
      if (attributeName === "href" && !attribute.value.trim().startsWith("#")) {
        element = `${appUiIcon.source} links <${tag.name}> to ${attribute.value}. Link only to an element in the icon itself, such as href="#shape"; an icon can't load other files.`;
        return;
      }
    }
  });
  Result.try(() => parser.write(content).close());
  if (doctype)
    return `${appUiIcon.source} declares a DOCTYPE. Remove it; an icon can't declare a DOCTYPE or entities.`;
  if (malformed !== undefined || root === undefined)
    return `${appUiIcon.source} is not well-formed XML: ${malformed ?? "it has no root element"}. Write it as an SVG file, as a vector editor exports it.`;
  if (!root) return shapeRequired;
  if (instruction !== undefined)
    return `${appUiIcon.source} has a <?${instruction}?> instruction. Remove it; an icon can't load stylesheets or other files.`;
  return element;
};

const checkIcon = (content: string) =>
  Effect.gen(function* () {
    const body = new TextEncoder().encode(content);
    if (body.length > appUiIconMaxBytes)
      return yield* sourceFailure(
        appUiIcon.source,
        `${appUiIcon.source} is ${body.length} bytes; an icon can be at most ${appUiIconMaxBytes}. Simplify or minify it.`,
      );
    const problem = iconProblem(content);
    if (problem !== undefined) return yield* sourceFailure(appUiIcon.source, problem);
    return { path: appUiIcon.asset, contentType: "image/svg+xml", body } satisfies UiBuildFile;
  });

const render = (plan: Plan, outputs: readonly UiBuildEntry[], assets: Map<string, UiBuildFile>) =>
  Effect.gen(function* () {
    const head = elements(plan.document).find((element) => element.tagName === "head");
    for (const entry of plan.entries) {
      const emitted = outputs.find((output) => output.source === entry.source);
      if (emitted === undefined || !assets.has(emitted.path)) return yield* failed();
      const attribute = entry.element.attrs.find((attribute) => attribute.name === entry.attribute);
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
    return {
      path: appUiDocuments[plan.kind].asset,
      contentType: "text/html",
      body: new TextEncoder().encode(serialize(plan.document)),
    } satisfies UiBuildFile;
  });

export const prepareUiBuild = (
  files: CodeFiles,
  publicPaths: ReadonlyArray<string> = [],
): Effect.Effect<UiBuildPlan | undefined, RuntimeBuildFailed> =>
  Effect.gen(function* () {
    const source = (kind: AppUiDocument) =>
      files.find((file) => file.path === appUiDocuments[kind].source);
    const main = source("main");
    const menuBar = source("menuBar");
    if (main === undefined) {
      if (menuBar === undefined) return undefined;
      return yield* sourceFailure(
        appUiDocuments.menuBar.source,
        `${appUiDocuments.menuBar.source} needs ${appUiDocuments.main.source}: a menu-bar page belongs to an app with a main page.`,
      );
    }
    const served = new Set(publicPaths);
    const plans = [yield* planDocument("main", main.content, files, served)];
    if (menuBar !== undefined)
      plans.push(yield* planDocument("menuBar", menuBar.content, files, served));
    const iconSource = files.find((file) => file.path === appUiIcon.source);
    const icon = iconSource === undefined ? undefined : yield* checkIcon(iconSource.content);
    return {
      documents: plans.map(({ kind, html }) => ({ kind, html })),
      entries: [...new Set(plans.flatMap((plan) => plan.entries.map((entry) => entry.source)))],
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
          for (const plan of plans) {
            const page = yield* render(plan, outputs, assets);
            assets.set(page.path, page);
          }
          if (icon !== undefined) assets.set(icon.path, icon);
          assets.set(appUiPagesAsset, {
            path: appUiPagesAsset,
            contentType: "application/json",
            body: new TextEncoder().encode(
              JSON.stringify(
                Schema.encodeSync(AppUiPagesManifest)({
                  menuBar: menuBar !== undefined,
                  icon: icon !== undefined,
                }),
              ),
            ),
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
