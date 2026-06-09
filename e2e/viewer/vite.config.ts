import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The viewer SPA builds INTO e2e/runs/ next to the run data it renders, with
// relative asset paths + hash routing — so the one static directory serves
// from any mount point (locally at /, via tailscale at /runs/).
export default defineConfig({
  root: import.meta.dirname,
  base: "./",
  plugins: [react()],
  build: {
    outDir: "../runs",
    emptyOutDir: false,
  },
});
