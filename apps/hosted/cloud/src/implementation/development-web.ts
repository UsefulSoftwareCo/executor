/** Connect the shared Node development renderer to cloud's entry context. */
import type { Server } from "node:http";
import { developmentDashboard as sharedDevelopmentDashboard } from "@executor-js/dashboard-start/development";
import type { CloudEntryPage } from "../contracts/entry.ts";
import { DevelopmentWebFailed } from "../contracts/development.ts";
import { cloudDocumentContext, type CloudPageHosts } from "./dashboard.ts";
import { Effect } from "effect";

export const developmentDashboard = (
  root: string,
  server: Server,
  hmrOrigin: URL,
  apiOrigin: string,
  hosts: CloudPageHosts,
) =>
  sharedDevelopmentDashboard(root, server, hmrOrigin, apiOrigin).pipe(
    Effect.mapError(() => new DevelopmentWebFailed({ stage: "vite" })),
    Effect.map(({ document, handler }) => ({
      document: (entry: CloudEntryPage | null) => document(cloudDocumentContext(hosts)(entry)),
      handler,
    })),
  );
