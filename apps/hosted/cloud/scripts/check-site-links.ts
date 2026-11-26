import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { Effect, FileSystem, Path, Schema } from "effect";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import { parse, type HTMLElement } from "node-html-parser";
import { siteOrigin } from "@executor-js/marketing/site-origin";
import { workerFirstRoutes } from "../src/contracts/worker-first-routes.ts";

export class BrokenSiteLinks extends Schema.TaggedError<BrokenSiteLinks>()("BrokenSiteLinks", {
  links: Schema.Array(Schema.Struct({ target: Schema.String, pages: Schema.Array(Schema.String) })),
}) {}

class MissingHostedMcpEndpoint extends Schema.TaggedError<MissingHostedMcpEndpoint>()(
  "MissingHostedMcpEndpoint",
  { expected: Schema.String },
) {}

type Rule = Readonly<{ pattern: RegExp; target: string; status: number }>;
type MarkdownNode = ReturnType<typeof fromMarkdown>["children"][number];

const htmlReferences = (document: HTMLElement) =>
  document
    .querySelectorAll("[href], [src]")
    .flatMap((element) =>
      [element.getAttribute("href"), element.getAttribute("src")].filter(
        (reference) => reference !== undefined,
      ),
    );

const markdownReferences = (markdown: string) => {
  const references: string[] = [];
  const visit = (node: MarkdownNode) => {
    if ("url" in node) references.push(node.url);
    if (node.type === "html") references.push(...htmlReferences(parse(node.value)));
    if ("children" in node) node.children.forEach(visit);
  };
  const body = markdown.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u, "");
  fromMarkdown(body, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  }).children.forEach(visit);
  return references;
};

const routePattern = (source: string) =>
  new RegExp(
    "^" +
      source
        .split("/")
        .map((segment) =>
          segment === "*"
            ? ".*"
            : segment.startsWith(":")
              ? "[^/]+"
              : segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        )
        .join("/") +
      "$",
  );

const checkSiteLinks = Effect.gen(function* () {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const root = yield* path.fromFileUrl(new URL("../../../..", import.meta.url));
  const site = path.join(root, "apps/hosted/cloud/.generated/site");
  const llmsTxt = yield* fs.readFileString(path.join(site, "docs/llms.txt"));
  const expected = new URL("/mcp", process.env.EXECUTOR_MCP_ORIGIN ?? "https://mcp.executor.sh")
    .href;
  if (!llmsTxt.includes(`\`${expected}\``)) {
    yield* Effect.logError(`/docs/llms.txt must name the hosted MCP endpoint ${expected}`);
    return yield* new MissingHostedMcpEndpoint({ expected });
  }

  const files = new Set<string>();
  for (const entry of yield* fs.readDirectory(site, { recursive: true })) {
    if ((yield* fs.stat(path.join(site, entry))).type === "File")
      files.add(`/${entry.split(path.sep).join("/")}`);
  }

  const workerRoutes = workerFirstRoutes.map(routePattern);
  const rules: Array<Rule> = (yield* fs.readFileString(path.join(site, "_redirects")))
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .filter(([source]) => source !== undefined && source !== "" && !source.startsWith("#"))
    .map(([source = "", target = "", status = "302"]) => ({
      pattern: routePattern(source),
      target,
      status: Number(status),
    }));

  const resolveFile = (pathname: string, hops = 0): string | undefined => {
    if (hops > 5) return undefined;
    const rule = rules.find((candidate) => candidate.pattern.test(pathname));
    if (rule !== undefined) {
      if (rule.status === 200) return files.has(rule.target) ? rule.target : undefined;
      const target = new URL(rule.target, siteOrigin);
      return target.origin === siteOrigin ? resolveFile(target.pathname, hops + 1) : undefined;
    }
    if (files.has(pathname)) return pathname;
    if (pathname === "/" && files.has("/index.html")) return "/index.html";
    return undefined;
  };

  const pageRoute = (file: string) =>
    file === "/index.html"
      ? "/"
      : file.endsWith("/index.html")
        ? file.slice(0, -"/index.html".length)
        : file.slice(0, -".html".length);

  const documents = new Map<string, { references: string[]; anchors: Set<string | undefined> }>();
  const readHtml = (file: string) =>
    Effect.gen(function* () {
      const existing = documents.get(file);
      if (existing !== undefined) return existing;
      const html = parse(yield* fs.readFileString(path.join(site, file)));
      const document = {
        references: htmlReferences(html),
        anchors: new Set([
          ...html.querySelectorAll("[id]").map((element) => element.getAttribute("id")),
          ...html.querySelectorAll("a[name]").map((element) => element.getAttribute("name")),
        ]),
      };
      documents.set(file, document);
      return document;
    });

  const anchorPage = (file: string) => {
    if (file.endsWith(".html")) return file;
    if (file.endsWith("/index.md")) return resolveFile(file.slice(0, -"/index.md".length) || "/");
    if (file.endsWith(".md")) {
      const stem = file.slice(0, -".md".length);
      return resolveFile(stem) ?? resolveFile(stem + ".html");
    }
    return undefined;
  };

  const docsPath = (pathname: string) => pathname === "/docs" || pathname.startsWith("/docs/");
  const fullText = "/docs/llms-full.txt";
  const broken = new Map<string, Set<string>>();
  const record = (target: string, page: string) => {
    const pages = broken.get(target) ?? new Set();
    pages.add(page);
    broken.set(target, pages);
  };
  if (!files.has(fullText)) record(fullText, "/docs");

  let markdownCount = 0;
  for (const file of files) {
    const markdown = file.endsWith(".md");
    const agentText = markdown || file === fullText;
    if (!agentText && !file.endsWith(".html")) continue;
    const page = agentText ? file : pageRoute(file);
    const agentDocs = agentText && docsPath(file);
    const references = agentText
      ? markdownReferences(yield* fs.readFileString(path.join(site, file)))
      : (yield* readHtml(file)).references;
    if (markdown) markdownCount++;

    for (const reference of references) {
      if (reference === "" || (file === "/404.html" && reference.startsWith("#"))) continue;
      const url = yield* Effect.try(() => new URL(reference, new URL(page, siteOrigin))).pipe(
        Effect.option,
      );
      if (url._tag === "None" || url.value.origin !== siteOrigin) continue;
      const { pathname, hash } = url.value;
      const decoded = yield* Effect.try(() => ({
        pathname: decodeURI(pathname),
        anchor: decodeURIComponent(hash.slice(1)),
      })).pipe(Effect.option);
      if (
        decoded._tag === "None" ||
        (file === fullText && !reference.startsWith("/") && !URL.canParse(reference))
      ) {
        record(pathname + hash, page);
        continue;
      }
      const decodedPath = decoded.value.pathname;
      const target = reference.startsWith("#") ? file : resolveFile(decodedPath);
      if (
        agentDocs &&
        !docsPath(decodedPath) &&
        decodedPath !== "/" &&
        reference.startsWith("/") &&
        resolveFile("/docs" + decodedPath) !== undefined
      ) {
        record(pathname + hash, page);
        continue;
      }
      if (target === undefined) {
        const workerRoute = workerRoutes.some((route) => route.test(decodedPath));
        if (!docsPath(decodedPath) && !agentDocs && workerRoute) continue;
        record(pathname + hash, page);
        continue;
      }
      if (!hash) continue;
      const html = anchorPage(target);
      if (html === undefined) continue;
      const { anchors } = yield* readHtml(html);
      if (!anchors.has(decoded.value.anchor)) record(pathname + hash, page);
    }
  }

  if (broken.size > 0) {
    for (const [target, pages] of broken)
      yield* Effect.logError(`${target} is linked from ${[...pages].join(", ")}`);
    return yield* new BrokenSiteLinks({
      links: [...broken].map(([target, pages]) => ({ target, pages: [...pages] })),
    });
  }
  yield* Effect.log(
    `Every same-origin link in the site HTML, ${markdownCount} Markdown files, and ${fullText} resolves.`,
  );
}).pipe(Effect.provide(NodeServices.layer));

NodeRuntime.runMain(checkSiteLinks);
