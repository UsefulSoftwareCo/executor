import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";
import { licenseNotices } from "./notices.ts";

const collector = process.env.COLLECTOR_URL;
const notices = licenseNotices(import.meta.dirname);

export default defineConfig({
  plugins: [notices.recordingStylesheetSources(tailwindcss()), react(), notices.write],
  server: collector === undefined ? {} : { proxy: { "/api": collector } },
  build: {
    outDir: "../dist/viewer",
    emptyOutDir: true,
  },
});
