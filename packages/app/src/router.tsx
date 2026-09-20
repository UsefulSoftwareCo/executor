import { createRouter } from "@tanstack/react-router";
import { sharedConsoleRouterOptions } from "@executor-js/react/console-router-options";
import { routeTree } from "./routeTree.gen";

export const getRouter = () => {
  return createRouter({
    routeTree,
    ...sharedConsoleRouterOptions,
  });
};
