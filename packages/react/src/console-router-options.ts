// Shared TanStack Router options for every Executor console host (desktop app,
// cloud, self-host, Cloudflare). Keep navigation snappy: code-split route
// chunks preload on link hover so clicking a sidebar tab does not suspend on
// an empty outlet while the chunk downloads.

export const sharedConsoleRouterOptions = {
  scrollRestoration: true,
  defaultPreload: "intent" as const,
  // Effect atoms own their own cache; we do not use route loaders for data.
  defaultPreloadStaleTime: 0,
};
