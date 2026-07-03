import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";
import { withBotId } from "botid/next/config";
import { withEve } from "eve/next";
import { withWorkflow } from "workflow/next";

const appRoot = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(appRoot, "../..");

const nextConfig: NextConfig = {
  allowedDevOrigins: ["pi", "100.67.149.2", "desktop"],
  outputFileTracingRoot: workspaceRoot,
  transpilePackages: [
    "@executor-js/api",
    "@executor-js/execution",
    "@executor-js/fumadb",
    "@executor-js/integrations-registry",
    "@executor-js/plugin-file-secrets",
    "@executor-js/plugin-graphql",
    "@executor-js/plugin-mcp",
    "@executor-js/plugin-openapi",
    "@executor-js/react",
    "@executor-js/runtime-quickjs",
    "@executor-js/sdk",
    "@open-agents/model-settings",
    "@open-agents/sandbox",
    "@open-agents/shared",
  ],
  serverExternalPackages: ["quickjs-emscripten"],
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "avatars.githubusercontent.com",
      },
      {
        protocol: "https",
        hostname: "vercel.com",
      },
      {
        protocol: "https",
        hostname: "*.vercel.com",
      },
    ],
  },
  experimental: {
    optimizePackageImports: ["lucide-react"],
  },
  turbopack: {
    root: workspaceRoot,
  },
  webpack(config) {
    const workflowGeneratedRoutePattern = /[/\\]\.well-known[/\\]workflow[/\\]/;

    config.watchOptions = {
      ...config.watchOptions,
      ignored: workflowGeneratedRoutePattern,
    };

    return config;
  },
};

export default withEve(withWorkflow(withBotId(nextConfig)), {
  eveRoot: workspaceRoot,
  eveBuildCommand:
    "bun run apps/open-agents/scripts/verify-eve-vercel-output-patch.ts && eve build && bun run apps/open-agents/scripts/patch-eve-vercel-output.ts",
});
