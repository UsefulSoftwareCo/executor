import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Standalone SPA reproduction of the current add-integration flow. No executor
// API, no auth, no backend — every screen runs off `src/fixtures.ts` plus the
// live public integrations.sh catalog, so the flow can be redesigned without
// standing up a tenant.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { port: 5199 },
});
