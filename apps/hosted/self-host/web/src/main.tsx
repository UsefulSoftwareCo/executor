import { sessionInitialValues } from "@executor-js/hosted-web/contracts/auth";
import { Effect } from "effect";
import { PageTelemetry } from "@executor-js/hosted-web/contracts/telemetry";
import { BrowserTelemetry } from "@executor-js/telemetry/browser";
import { RegistryProvider } from "@effect/atom-react";
import { RouterProvider } from "@tanstack/react-router";
import { createRoot } from "react-dom/client";
import { createDashboardRouter } from "./implementation/router.ts";
import "@executor-js/hosted-web/styles";

const root = document.getElementById("root");
if (root === null) throw new Error("Dashboard root is missing");

const router = createDashboardRouter();
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
  <RegistryProvider initialValues={sessionInitialValues()}>
    <RouterProvider router={router} />
  </RegistryProvider>,
);
