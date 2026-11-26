import { dashboardStartPlugins } from "@executor-js/dashboard-start/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite-plus";

const desktopDevelopment = process.env.EXECUTOR_DESKTOP_DEV === "1";
const tailwind = tailwindcss();
if (desktopDevelopment) {
  for (const plugin of tailwind) delete plugin.hotUpdate;
}

export default defineConfig({
  experimental: { bundledDev: desktopDevelopment },
  plugins: dashboardStartPlugins({ runtime: "node", tailwind }),
});
