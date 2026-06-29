// Unsigned packaging config for e2e: produces the SAME app bundle as the
// release config (same bundled executor extraResource, same main/
// preload `out/`), but skips Apple signing/notarization so it builds with no
// CSC_LINK / APPLE_API_KEY. The e2e drives the resulting bundle through
// Playwright `_electron`; in a VM, Gatekeeper is bypassed (the app is
// quarantine-cleared) so the unsigned bundle launches.
//
// Used via `electron-builder --config electron-builder.e2e.config.ts`. The
// release path (publish-desktop.yml) still uses electron-builder.config.ts —
// this override never touches production signing.
import base from "./electron-builder.config";

import type { Configuration } from "electron-builder";

const config: Configuration = {
  ...base,
  mac: {
    ...base.mac,
    // No Apple Developer credentials in e2e — produce an unsigned bundle.
    hardenedRuntime: false,
    gatekeeperAssess: false,
    notarize: false,
    identity: null,
    // `dir` = the unpacked .app (the real bundle electron-builder assembles,
    // with extraResources), without the slow DMG/zip wrap. _electron launches
    // the .app directly, so the distribution container adds nothing here.
    target: ["dir"],
  },
  win: {
    ...base.win,
    target: ["dir"],
  },
  linux: {
    ...base.linux,
    // Pin a clean executable name — electron-builder otherwise derives it from
    // the scoped package name (`@executor-jsdesktop`), which the e2e globalsetup
    // would have to special-case.
    executableName: "executor-desktop",
    target: ["dir"],
  },
  // The release config publishes to GitHub; an e2e build must never try to.
  publish: null,
};

export default config;
