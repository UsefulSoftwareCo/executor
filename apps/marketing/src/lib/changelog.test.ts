import { describe, expect, it } from "@effect/vitest";

import { parseChangelog } from "./changelog";

describe("parseChangelog", () => {
  it("strips changesets boilerplate and captures PR metadata", () => {
    const releases = parseChangelog(`# executor

## 1.5.29

### Patch Changes

- [#1341](https://github.com/UsefulSoftwareCo/executor/pull/1341) [\`5656c3e\`](https://github.com/UsefulSoftwareCo/executor/commit/5656c3e2fbb1982510267a7999f4ae37cdb5a381) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - Fix 1Password desktop-app connections failing with "undefined is not a constructor (evaluating 'new n.DesktopAuth(...)')" in packaged builds. The compiled binary now bundles the 1Password SDK's wasm core correctly and falls back to a copy shipped next to the binary, so vault listing and secret resolution work without the \`op\` CLI installed.

- Updated dependencies []:
  - @executor-js/sdk@1.5.29
  - @executor-js/runtime-quickjs@1.5.29
  - @executor-js/local@1.4.4
  - @executor-js/api@1.4.49
`);

    expect(releases).toEqual([
      {
        version: "1.5.29",
        entries: [
          {
            prNumber: 1341,
            prUrl: "https://github.com/UsefulSoftwareCo/executor/pull/1341",
            body: "Fix 1Password desktop-app connections failing with \"undefined is not a constructor (evaluating 'new n.DesktopAuth(...)')\" in packaged builds. The compiled binary now bundles the 1Password SDK's wasm core correctly and falls back to a copy shipped next to the binary, so vault listing and secret resolution work without the `op` CLI installed.",
          },
        ],
      },
    ]);
  });

  it("drops dependency-only releases", () => {
    const releases = parseChangelog(`# executor

## 1.5.28

### Patch Changes

- Updated dependencies [[\`1c48182\`](https://github.com/UsefulSoftwareCo/executor/commit/1c4818254e71dc4ee27ff95f489e2c5cf330a450)]:
  - @executor-js/sdk@1.5.28
  - @executor-js/local@1.4.4
  - @executor-js/api@1.4.48
  - @executor-js/runtime-quickjs@1.5.28
`);

    expect(releases).toEqual([]);
  });

  it("keeps release entries while dropping dependency blocks", () => {
    const releases = parseChangelog(`# executor

## 1.5.26

### Patch Changes

- [#1221](https://github.com/RhysSullivan/executor/pull/1221) [\`3606317\`](https://github.com/RhysSullivan/executor/commit/360631733e0d0595094a06b9a9fbe06b2714d16c) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - Send correct \`Cache-Control\` headers for the self-hosted web app. The SPA shell (\`index.html\`) and its client-route fallbacks are now served with \`no-cache\`, so a new deploy is picked up on the next visit instead of the browser rendering a stale UI from cache until a hard refresh. Content-hashed \`/assets/*\` are served \`immutable\` and cached long-term.

- Updated dependencies []:
  - @executor-js/sdk@1.5.26
  - @executor-js/runtime-quickjs@1.5.26
  - @executor-js/local@1.4.4
  - @executor-js/api@1.4.46
`);

    expect(releases).toEqual([
      {
        version: "1.5.26",
        entries: [
          {
            prNumber: 1221,
            prUrl: "https://github.com/RhysSullivan/executor/pull/1221",
            body: "Send correct `Cache-Control` headers for the self-hosted web app. The SPA shell (`index.html`) and its client-route fallbacks are now served with `no-cache`, so a new deploy is picked up on the next visit instead of the browser rendering a stale UI from cache until a hard refresh. Content-hashed `/assets/*` are served `immutable` and cached long-term.",
          },
        ],
      },
    ]);
  });

  it("passes plain entries through and dedents continuation lines", () => {
    const releases = parseChangelog(`# executor

## 1.5.0

### Minor Changes

- Integrations and connections rework.

  **Highlights**
  - Sources are now split into integrations (the API surface) and connections (the credential). One integration can hold many connections — workspace-shared or personal — and each connection gets its own tool catalog.
`);

    expect(releases).toEqual([
      {
        version: "1.5.0",
        entries: [
          {
            body: "Integrations and connections rework.\n\n**Highlights**\n- Sources are now split into integrations (the API surface) and connections (the credential). One integration can hold many connections — workspace-shared or personal — and each connection gets its own tool catalog.",
          },
        ],
      },
    ]);
  });
});
