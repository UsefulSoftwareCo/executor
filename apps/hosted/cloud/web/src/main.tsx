import { cloudEntryInitialValues } from "./implementation/entry.ts";
import { startErrorReporting, reactErrorHandlers } from "./implementation/error-reporting.tsx";
import { startAnalytics, capturePageview, pauseReplay } from "./implementation/analytics.tsx";
import { Effect } from "effect";
import { PageTelemetry } from "@executor-js/hosted-web/contracts/telemetry";
import { BrowserTelemetry } from "@executor-js/telemetry/browser";
import { RegistryProvider } from "@effect/atom-react";
import { RouterProvider } from "@tanstack/react-router";
import { createRoot } from "react-dom/client";
import { createDashboardRouter } from "./implementation/router.ts";
import "@executor-js/hosted-web/styles";
import { UIObservation } from "./implementation/ui-observation.tsx";

const root = document.getElementById("root");
if (root === null) throw new Error("Dashboard root is missing");

const initialValues = cloudEntryInitialValues();

// This public page carries an unsubscribe capability in its fragment. No identity
// lookup, analytics or browser error reporting should receive that URL.
const publicEmailPage = window.location.pathname.startsWith("/email/unsubscribe");
if (!publicEmailPage) {
  startAnalytics();
  startErrorReporting();
}
const router = createDashboardRouter();
if (!publicEmailPage) {
  router.subscribe("onBeforeNavigate", ({ toLocation }) => {
    pauseReplay();
    PageTelemetry.runFork(
      Effect.flatMap(BrowserTelemetry, (telemetry) =>
        telemetry.navigation({ type: "start", path: toLocation.pathname }),
      ),
    );
  });
  router.subscribe("onResolved", () => {
    capturePageview(router.state.location.pathname);
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
}
if (import.meta.hot)
  import.meta.hot.dispose(() => {
    void PageTelemetry.dispose().catch((error) => console.error(error));
  });
createRoot(root, reactErrorHandlers).render(
  <RegistryProvider initialValues={initialValues}>
    <UIObservation>
      <RouterProvider router={router} />
    </UIObservation>
  </RegistryProvider>,
);
