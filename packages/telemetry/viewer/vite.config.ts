import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";

// The collector serves this build at its origin root, beside the API the viewer reads.
// `vp dev` forwards the API to a running collector named by COLLECTOR_URL.
const collector = process.env.COLLECTOR_URL;

export default defineConfig({
  plugins: [tailwindcss(), react()],
  server: collector === undefined ? {} : { proxy: { "/api": collector } },
  build: {
    outDir: "../dist/collector/viewer",
    emptyOutDir: true,
  },
});
