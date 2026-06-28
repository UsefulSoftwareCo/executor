import { defineClientPlugin } from "@executor-js/sdk/client";

import { ToolkitsPage } from "./page";

export default defineClientPlugin({
  id: "toolkits" as const,
  pages: [
    {
      path: "/",
      component: ToolkitsPage,
    },
    {
      path: "/$toolkitSlug",
      component: ToolkitsPage,
    },
  ],
});
