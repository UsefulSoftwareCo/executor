import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { Effect, FileSystem, Path, Schema } from "effect";
import { siteRedirects } from "../src/implementation/site-redirects.ts";

export class SiteAssetCollision extends Schema.TaggedError<SiteAssetCollision>()(
  "SiteAssetCollision",
  { asset: Schema.String, sources: Schema.Array(Schema.String) },
) {}

export class SiteAssetNotPublishable extends Schema.TaggedError<SiteAssetNotPublishable>()(
  "SiteAssetNotPublishable",
  { asset: Schema.String },
) {}

type Asset = Readonly<{ source: string; relative: string }>;

const siteBuild = Effect.gen(function* () {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const root = yield* path.fromFileUrl(new URL("../../../..", import.meta.url));
  const marketing = path.join(root, "apps/marketing/dist");
  const dashboard = path.join(root, "apps/hosted/cloud/web/dist");
  // Blume builds the documentation with a deployment base of /docs, so its own
  // output is still rooted at dist. It moves below docs/ here. Everything in
  // that build ships, not just the HTML: llms.txt, llms-full.txt and the .md
  // and .mdx variant of every page are the agent-facing half of the site.
  const docs = path.join(root, "apps/docs/dist");
  const docsPrefix = "docs";
  const output = path.join(root, "apps/hosted/cloud/.generated/site");

  // The asset root is public and unauthenticated. Both front-end builds set
  // `sourcemap: "hidden"`, which writes .map files into dist for an error
  // tracker to upload; the only thing that removes them is a Sentry plugin that
  // runs solely when SENTRY_AUTH_TOKEN is set. Decide publication here instead
  // of trusting that upstream step. Dot-entries are build metadata
  // (.vite/manifest.json) or editor and OS leftovers (.DS_Store). `.well-known`
  // is the one dot-directory the web expects to be served, so it is exempt.
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

  // The asset layer reads _redirects and _headers from the asset root only, so
  // a copy of either inside a mounted build would be an inert file. Both are
  // composed below from every build instead.
  const directives = ["_redirects", "_headers"];

  const addAsset = (asset: Asset, relative = asset.relative) => {
    // The dashboard entry is renamed so the marketing site's index remains the
    // asset root.
    if (directives.includes(asset.relative)) return;
    const destination =
      relative === "index.html" && asset.source.startsWith(dashboard) ? "dashboard.html" : relative;
    const existing = assets.get(destination) ?? [];
    existing.push({ ...asset, relative: destination });
    assets.set(destination, existing);
  };
  for (const asset of marketingAssets) addAsset(asset);
  for (const asset of dashboardAssets) addAsset(asset);
  for (const asset of docsAssets) addAsset(asset, path.join(docsPrefix, asset.relative));

  // listAssets decides publication. addAsset renames and prefixes entries after
  // that, so assert once that what actually ships still passes the same rule.
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

  // workerd holds an open handle to the asset root in dev. Keep that directory
  // alive when rebuilding; replacing it leaves the running disk service on an
  // unlinked directory even after new files are written at the same path.
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

  // Asset serving uses htmlHandling "none", so every prerendered page needs an
  // explicit rewrite. The canonical route has no trailing slash; the slashed
  // form redirects onto it.
  const pageRedirects = (pageAssets: ReadonlyArray<Asset>, prefix: string) => {
    const lines = new Set<string>();
    for (const asset of pageAssets) {
      if (!asset.relative.endsWith(".html")) continue;
      const relative = `${prefix}${asset.relative.replaceAll(path.sep, "/")}`;
      const withoutPage = relative.endsWith("/index.html")
        ? relative.slice(0, -"/index.html".length)
        : relative === "index.html"
          ? ""
          : relative.slice(0, -".html".length);
      // The marketing index is the asset root and needs no rewrite.
      if (withoutPage === "") continue;
      const route = `/${withoutPage}`;
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
  // "/docs" and "/docs/" both reach the documentation index.
  const docsRedirects = pageRedirects(docsAssets, `${docsPrefix}/`);

  const customMarketingRedirectsPath = path.join(marketing, "_redirects");
  const customMarketingRedirects = (yield* fs.exists(customMarketingRedirectsPath))
    ? (yield* fs.readFileString(customMarketingRedirectsPath))
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
    : [];
  const dashboardRedirects = yield* fs.readFileString(path.join(dashboard, "_redirects"));
  const redirects = new Set([
    ...marketingRedirects,
    ...customMarketingRedirects,
    ...docsRedirects,
    ...dashboardRedirects
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean),
  ]);
  yield* fs.writeFileString(path.join(output, "_redirects"), yield* siteRedirects(redirects));

  // _headers is block-structured, not one rule per line, so the files are
  // concatenated rather than merged into a set. Blume writes its rules already
  // prefixed with the /docs base, which is what gives the Markdown mirrors and
  // llms.txt their text/markdown and text/plain content types.
  const headerFiles: Array<string> = [];
  for (const directory of [marketing, dashboard, docs]) {
    const file = path.join(directory, "_headers");
    if (yield* fs.exists(file)) headerFiles.push((yield* fs.readFileString(file)).trim());
  }
  if (headerFiles.length > 0) {
    yield* fs.writeFileString(path.join(output, "_headers"), headerFiles.join("\n\n") + "\n");
  }
}).pipe(Effect.provide(NodeServices.layer));

NodeRuntime.runMain(siteBuild);
