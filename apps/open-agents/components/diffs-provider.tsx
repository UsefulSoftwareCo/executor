"use client";

import { WorkerPoolContextProvider } from "@pierre/diffs/react";
import "@/lib/vercel-themes";

export function DiffsProvider({ children }: { children: React.ReactNode }) {
  return (
    <WorkerPoolContextProvider
      poolOptions={{
        poolSize: 2,
        workerFactory: () =>
          new Worker(
            new URL("@pierre/diffs/worker/worker.js", import.meta.url),
          ),
      }}
      highlighterOptions={{
        theme: {
          dark: "vercel-dark",
          light: "vercel-light",
        },
        langs: [],
      }}
    >
      {children}
    </WorkerPoolContextProvider>
  );
}
