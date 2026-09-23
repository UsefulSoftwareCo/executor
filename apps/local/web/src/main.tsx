import { PageTelemetry } from "./contracts/telemetry.ts";
import { BrowserTelemetry } from "@executor-js/telemetry/browser";
import { RegistryProvider } from "@effect/atom-react";
import { Effect } from "effect";
import { createRoot } from "react-dom/client";
import { createBrowserHistory, RouterProvider } from "@tanstack/react-router";
import { getRouter } from "./implementation/router.ts";
import { pairingTokenAtom } from "./contracts/connection.ts";
import { readPairingToken } from "./implementation/connection.ts";
import { oauthCallbackAtom } from "./contracts/oauth.ts";
import { readOAuthCallback } from "./implementation/oauth.ts";
import { connectionEntryAtom } from "./contracts/account-connections.ts";
import { readAccountConnection } from "./implementation/account-connections.ts";
import "./implementation/styles/globals.css";

const root = document.getElementById("root");
if (!root) throw new Error("Dashboard root is missing");
const token = Effect.runSync(readPairingToken);
const accountConnection = Effect.runSync(readAccountConnection);
const callback = Effect.runSync(readOAuthCallback);
// Consume and erase entry credentials before the router sees the location.
const router = getRouter(createBrowserHistory());
router.subscribe("onBeforeNavigate", ({ toLocation }) => {
  PageTelemetry.runFork(
    Effect.flatMap(BrowserTelemetry, (telemetry) =>
      telemetry.navigation({ type: "start", path: toLocation.pathname }),
    ),
  );
});
router.subscribe("onResolved", () => {
  PageTelemetry.runFork(
    Effect.flatMap(BrowserTelemetry, (telemetry) => telemetry.navigation({ type: "end" })),
  );
});
// Start page-owned listeners independently of component query lifetimes.
void PageTelemetry.runPromise(
  Effect.flatMap(BrowserTelemetry, (telemetry) =>
    telemetry.navigation({ type: "start", path: window.location.pathname }),
  ),
).catch((error) => console.error(error));
if (import.meta.hot)
  import.meta.hot.dispose(() => {
    void PageTelemetry.dispose().catch((error) => console.error(error));
  });
createRoot(root).render(
  <RegistryProvider
    initialValues={[
      [pairingTokenAtom, token],
      [oauthCallbackAtom, callback],
      [connectionEntryAtom, accountConnection],
    ]}
  >
    <RouterProvider router={router} />
  </RegistryProvider>,
);
