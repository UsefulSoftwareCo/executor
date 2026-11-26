import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { createHash } from "node:crypto";
import { Effect, FileSystem, Path, Schema } from "effect";
import { productionSiteOrigin, siteOrigin } from "@executor-js/marketing/site-origin";
import { v1SitePages } from "../src/contracts/site-paths.ts";
import { siteRedirects } from "../src/implementation/site-redirects.ts";
import {
  RetainedAssetList,
  retainedAssetCacheControl,
  retainedAssetFolders,
  retainedAssetList,
  retainedAssetPath,
} from "../src/contracts/retained-assets.ts";

export class SiteAssetCollision extends Schema.TaggedError<SiteAssetCollision>()(
  "SiteAssetCollision",
  { asset: Schema.String, sources: Schema.Array(Schema.String) },
) {}

export class SiteAssetNotHashed extends Schema.TaggedError<SiteAssetNotHashed>()(
  "SiteAssetNotHashed",
  { asset: Schema.String },
) {}

export class SiteAssetNotPublishable extends Schema.TaggedError<SiteAssetNotPublishable>()(
  "SiteAssetNotPublishable",
  { asset: Schema.String },
) {}

type Asset = Readonly<{ source: string; relative: string }>;

const markup = (tag: string, entry: string, paths: Iterable<string>) =>
  [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<${tag} xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`,
    ...Array.from(paths, (path) => {
      const url = new URL(path, siteOrigin).href.replaceAll("&", "&amp;");
      return `  <${entry}><loc>${url}</loc></${entry}>`;
    }),
    `</${tag}>`,
    "",
  ].join("\n");

const siteBuild = Effect.gen(function* () {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const root = yield* path.fromFileUrl(new URL("../../../..", import.meta.url));
  const marketing = path.join(root, "apps/marketing/dist");
  const dashboard = path.join(root, "apps/hosted/cloud/web/dist/client");
  const docs = path.join(root, "apps/docs/dist");
  const docsPrefix = "docs";
  const output = path.join(root, "apps/hosted/cloud/.generated/site");

  const isPublishable = (relative: string) =>
    !relative.endsWith(".map") &&
    !relative
      .split(path.sep)
      .some((segment) => segment.startsWith(".") && segment !== ".well-known");

  const listAssets = (directory: string) =>
    Effect.gen(function* () {
      const entries = yield* fs.readDirectory(directory, { recursive: true });
      const assets: Array<Asset> = [];
      for (const entry of entries) {
        const source = path.join(directory, entry);
        const info = yield* fs.stat(source);
        if (info.type === "File" && isPublishable(entry)) assets.push({ source, relative: entry });
      }
      return assets;
    });

  const marketingAssets = yield* listAssets(marketing);
  const dashboardAssets = yield* listAssets(dashboard);
  const docsAssets = yield* listAssets(docs);
  const assets = new Map<string, Array<Asset>>();

  const directives = ["_redirects", "_headers"];

  const addAsset = (asset: Asset, relative = asset.relative) => {
    if (directives.includes(asset.relative)) return;
    const existing = assets.get(relative) ?? [];
    existing.push({ ...asset, relative });
    assets.set(relative, existing);
  };
  for (const asset of marketingAssets) addAsset(asset);
  for (const asset of dashboardAssets) addAsset(asset);
  for (const asset of docsAssets) addAsset(asset, path.join(docsPrefix, asset.relative));

  const notPublishable = [...assets.keys()].find((relative) => !isPublishable(relative));
  if (notPublishable !== undefined) {
    return yield* Effect.fail(new SiteAssetNotPublishable({ asset: notPublishable }));
  }

  for (const [relative, matches] of assets) {
    if (matches.length > 1) {
      return yield* Effect.fail(
        new SiteAssetCollision({
          asset: relative,
          sources: matches.map((match) => match.source),
        }),
      );
    }
  }

  yield* fs.makeDirectory(output, { recursive: true });
  for (const entry of yield* fs.readDirectory(output)) {
    yield* fs.remove(path.join(output, entry), { recursive: true, force: true });
  }
  for (const [relative, matches] of assets) {
    const asset = matches[0];
    if (asset === undefined)
      return yield* Effect.die(`Asset map entry "${relative}" has no source.`);
    const destination = path.join(output, relative);
    yield* fs.makeDirectory(path.dirname(destination), { recursive: true });
    yield* fs.copyFile(asset.source, destination);
  }

  const retained = [...assets.keys()]
    .map((relative) => relative.split(path.sep).join("/"))
    .filter((relative) => retainedAssetFolders.some((folder) => relative.startsWith(`${folder}/`)))
    .sort();
  const unhashed = retained.find((relative) => !retainedAssetPath.test(relative));
  if (unhashed !== undefined)
    return yield* Effect.fail(new SiteAssetNotHashed({ asset: unhashed }));
  yield* fs.writeFileString(
    path.join(output, retainedAssetList),
    yield* Schema.encodeEffect(Schema.fromJsonString(RetainedAssetList))({
      build: createHash("sha256").update(retained.join("\n")).digest("hex"),
      files: retained,
    }),
  );

  const pageRoute = (file: string) =>
    file === "index.html"
      ? "/"
      : file.endsWith("/index.html")
        ? `/${file.slice(0, -"/index.html".length)}`
        : `/${file.slice(0, -".html".length)}`;

  const pageRedirects = (pageAssets: ReadonlyArray<Asset>, prefix: string) => {
    const lines = new Set<string>();
    for (const asset of pageAssets) {
      if (!asset.relative.endsWith(".html")) continue;
      if (asset.relative === "404.html") continue;
      const relative = `${prefix}${asset.relative.replaceAll(path.sep, "/")}`;
      const route = pageRoute(relative);
      if (route === "/") continue;
      lines.add(`${route} /${relative} 200`);
      lines.add(`${route}/ ${route} 308`);
    }
    return lines;
  };

  const marketingRedirects = new Set<string>([
    "/home /index.html 200",
    "/home/ /home 308",
    ...pageRedirects(marketingAssets, ""),
  ]);
  const docsRedirects = pageRedirects(docsAssets, `${docsPrefix}/`);

  const customMarketingRedirectsPath = path.join(marketing, "_redirects");
  const customMarketingRedirects = (yield* fs.exists(customMarketingRedirectsPath))
    ? (yield* fs.readFileString(customMarketingRedirectsPath))
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
    : [];
  const redirects = new Set([...marketingRedirects, ...customMarketingRedirects, ...docsRedirects]);
  yield* fs.writeFileString(path.join(output, "_redirects"), yield* siteRedirects(redirects));

  const marketingPages = new Set<string>();
  for (const asset of marketingAssets) {
    if (!asset.relative.endsWith(".html") || asset.relative === "404.html") continue;
    const route = pageRoute(asset.relative.replaceAll(path.sep, "/"));
    if (route === "/apps/detail" || v1SitePages.some((legacy) => legacy === route)) continue;
    const html = yield* fs.readFileString(asset.source);
    if (/<meta name="robots" content="noindex\b/iu.test(html)) continue;
    marketingPages.add(route);
  }
  yield* fs.writeFileString(
    path.join(output, "sitemap-marketing.xml"),
    markup("urlset", "url", [...marketingPages].sort()),
  );
  yield* fs.writeFileString(
    path.join(output, "sitemap.xml"),
    markup("sitemapindex", "sitemap", ["/sitemap-marketing.xml", "/docs/sitemap.xml"]),
  );
  yield* fs.writeFileString(
    path.join(output, "robots.txt"),
    siteOrigin === productionSiteOrigin
      ? `User-agent: *\nAllow: /\nSitemap: ${siteOrigin}/sitemap.xml\n`
      : "User-agent: *\nDisallow: /\n",
  );

  const headerFiles: Array<string> = retainedAssetFolders.map(
    (folder) => `/${folder}/*\n  Cache-Control: ${retainedAssetCacheControl}`,
  );
  for (const directory of [marketing, dashboard, docs]) {
    const file = path.join(directory, "_headers");
    if (yield* fs.exists(file)) headerFiles.push((yield* fs.readFileString(file)).trim());
  }
  yield* fs.writeFileString(path.join(output, "_headers"), headerFiles.join("\n\n") + "\n");
}).pipe(Effect.provide(NodeServices.layer));

NodeRuntime.runMain(siteBuild);
