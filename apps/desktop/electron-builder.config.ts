import type { Configuration } from "electron-builder";

const config: Configuration = {
  appId: "sh.executor.desktop",
  productName: "Executor",
  artifactName: "executor-desktop-${os}-${arch}.${ext}",
  directories: {
    output: "dist",
    buildResources: "resources",
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
