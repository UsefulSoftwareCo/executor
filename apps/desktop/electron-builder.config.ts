import type { Configuration } from "electron-builder";

const config: Configuration = {
  appId: "sh.executor.desktop",
  productName: "Executor",
  artifactName: "executor-desktop-${os}-${arch}.${ext}",
  directories: {
    output: "dist",
    // Static build inputs live in build/ (icon.png, entitlements.mac.plist).
    // Runtime resources staged at build time (sidecar binary, web-ui) live
    // in resources/ and are wired in via `extraResources` below.
    buildResources: "build",
  },
  files: ["out/**/*", "package.json"],
  extraResources: [
    {
      from: "resources/sidecar/",
      to: "sidecar/",
      filter: ["**/*"],
    },
    {
      from: "resources/web-ui/",
      to: "web-ui/",
      filter: ["**/*"],
    },
  ],
  mac: {
    category: "public.app-category.developer-tools",
    target: [
      { target: "dmg", arch: ["arm64", "x64"] },
      { target: "zip", arch: ["arm64", "x64"] },
    ],
    hardenedRuntime: true,
    gatekeeperAssess: false,
    // electron-builder reads CSC_LINK / CSC_KEY_PASSWORD for the signing
    // identity and APPLE_API_KEY / APPLE_API_KEY_ID / APPLE_API_ISSUER
    // (set in publish-desktop.yml from repo secrets) to upload to Apple
    // for notarization. Locally, with none of those env vars set,
    // electron-builder skips signing and produces an unsigned build.
    entitlements: "build/entitlements.mac.plist",
    entitlementsInherit: "build/entitlements.mac.plist",
    notarize: true,
  },
  win: {
    target: [{ target: "nsis", arch: ["x64", "arm64"] }],
  },
  nsis: {
    oneClick: true,
    perMachine: false,
  },
  linux: {
    category: "Development",
    target: [
      { target: "AppImage", arch: ["x64", "arm64"] },
      { target: "deb", arch: ["x64", "arm64"] },
      { target: "rpm", arch: ["x64", "arm64"] },
    ],
  },
  publish: {
    provider: "github",
    owner: "RhysSullivan",
    repo: "executor",
  },
};

export default config;
