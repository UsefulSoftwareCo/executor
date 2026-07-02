// @ts-check
import { fileURLToPath } from "node:url";
import { defineConfig } from "astro/config";
import { unstable_readConfig } from "wrangler";

import tailwindcss from "@tailwindcss/vite";
import react from "@astrojs/react";

import cloudflare from "@astrojs/cloudflare";

// Single source of truth for public build-time vars: wrangler.toml `[vars]`.
// Mirrors apps/cloud, which reads its wrangler.jsonc vars the same way. The
// PUBLIC_ ones are inlined into the client bundle via Vite `define`, so the
// browser PostHog SDK gets the key at build time; they also remain runtime
// Worker bindings.
const wranglerPublicDefine = () => {
  const config = unstable_readConfig(
    { config: fileURLToPath(new URL("./wrangler.toml", import.meta.url)) },
    { hideWarnings: true },
  );
  return Object.fromEntries(
    Object.entries(config.vars ?? {})
      .filter(([key]) => key.startsWith("PUBLIC_"))
      .map(([key, value]) => [`import.meta.env.${key}`, JSON.stringify(value)]),
  );
};

// https://astro.build/config
export default defineConfig({
  site: "https://executor.sh",
  output: "server",
  integrations: [react()],
  vite: {
    plugins: [tailwindcss()],
    define: wranglerPublicDefine(),
  },

  adapter: cloudflare(),
});
