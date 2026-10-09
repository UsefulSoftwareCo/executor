import { expect, layer } from "@effect/vitest";
import { Effect } from "effect";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { scenarios } from "../test-plan.ts";

const repository = "https://github.com/UsefulSoftwareCo/executor";
const releasesApi = "https://api.github.com/repos/UsefulSoftwareCo/executor/releases?per_page=100";
const suffixes = [
  "-mac-arm64.dmg",
  "-mac-x64.dmg",
  "-linux-x86_64.AppImage",
  "-linux-arm64.AppImage",
  "-win-x64.exe",
];

const download = (tag: string, name: string) =>
  `${repository}/releases/download/${encodeURIComponent(tag)}/${name}`;

const githubRelease = (
  tag: string,
  prerelease: boolean,
  publishedAt: string,
  names: ReadonlyArray<string>,
) => ({
  tag_name: tag,
  draft: false,
  prerelease,
  published_at: publishedAt,
  assets: names.map((name) => ({ name, browser_download_url: download(tag, name) })),
});

const v2Installers = (version: string) =>
  suffixes.map((suffix) => `executor-desktop-${version}${suffix}`);

// GitHub's public list never includes drafts. Executor 1 releases share the
// repository and the version-free installer names, and the update feed is a
// newer v2 prerelease without installers, so neither may be chosen.
const releases = [
  githubRelease(
    "v1.6.11",
    false,
    "2026-10-05T12:00:00Z",
    suffixes.map((suffix) => `executor-desktop${suffix}`),
  ),
  githubRelease("executor-v2-desktop-updates", true, "2026-10-04T12:00:00Z", [
    "executor-v2-beta-mac.yml",
  ]),
  githubRelease(
    "executor@2.0.0-beta.21",
    true,
    "2026-10-03T12:00:00Z",
    v2Installers("2.0.0-beta.21"),
  ),
  githubRelease(
    "executor@2.0.0-beta.20",
    true,
    "2026-10-01T12:00:00Z",
    v2Installers("2.0.0-beta.20"),
  ),
  githubRelease("executor@2.0.0", false, "2026-09-30T12:00:00Z", v2Installers("2.0.0")),
];

const readDownloads = Effect.fn("readDownloads")(function* (step: string) {
  const browser = yield* Browser;
  return yield* browser.use(step, (page) =>
    page
      .locator("[data-download]")
      .first()
      .evaluate((root) => ({
        stableOnly: root.getAttribute("data-stable-only"),
        links: [...root.querySelectorAll<HTMLAnchorElement>(":scope > a[data-os]")].map((link) => ({
          asset: link.dataset.asset ?? "",
          href: link.href,
        })),
      })),
  );
});

layer(HostedLive, { excludeTestServices: true })("Desktop downloads", (it) => {
  it.effect(scenarios.desktopDownloads.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const browser = yield* Browser;
        yield* browser.use("Make the public release list unavailable", (page) =>
          page.route(releasesApi, (route) =>
            route.fulfill({ status: 403, contentType: "application/json", body: "{}" }),
          ),
        );
        yield* browser.use("Open the homepage while the release lookup fails", (page) =>
          Promise.all([page.waitForResponse(releasesApi), page.goto("/home#install")]),
        );
        const unavailable = yield* readDownloads("Read the downloads after the failed lookup");
        expect(unavailable.links.map((link) => link.asset)).toEqual(suffixes);
        for (const link of unavailable.links) expect(link.href).toBe(`${repository}/releases`);
        yield* browser.checkpoint("Downloads fall back to the releases page");

        yield* browser.use("Serve the public release list", (page) =>
          page
            .unroute(releasesApi)
            .then(() =>
              page.route(releasesApi, (route) =>
                route.fulfill({ status: 200, contentType: "application/json", json: releases }),
              ),
            ),
        );
        yield* browser.use("Reload the homepage", (page) => page.reload());
        yield* browser.use("Wait for the downloads to resolve", (page) =>
          page.waitForFunction(() =>
            [...document.querySelectorAll<HTMLAnchorElement>("[data-download] a[data-os]")].every(
              (link) => link.href.includes("/releases/download/"),
            ),
          ),
        );
        const resolved = yield* readDownloads("Read the resolved downloads");
        // Beta builds offer the newest v2 release; stable builds skip prereleases.
        const [tag, version] =
          resolved.stableOnly === "true"
            ? ["executor@2.0.0", "2.0.0"]
            : ["executor@2.0.0-beta.21", "2.0.0-beta.21"];
        expect(resolved.links).toEqual(
          suffixes.map((suffix) => ({
            asset: suffix,
            href: download(tag, `executor-desktop-${version}${suffix}`),
          })),
        );
        yield* browser.checkpoint("Downloads link to the newest published v2 release");

        const other = yield* browser.use("Read the other platform downloads", (page) =>
          page
            .locator("[data-download-other-list] a")
            .evaluateAll((links) => links.map((link) => (link as HTMLAnchorElement).href)),
        );
        expect(other).toHaveLength(suffixes.length - 1);
        for (const href of other) expect(href).toContain(encodeURIComponent(tag));
      }),
    ),
  );
});
