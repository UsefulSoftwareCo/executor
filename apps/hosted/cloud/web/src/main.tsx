import { reactErrorHandlers } from "./implementation/error-reporting.tsx";
import { startAnalytics, capturePageview, pauseReplay } from "./implementation/analytics.tsx";
import { Effect } from "effect";
import { PageTelemetry } from "@executor-js/hosted-web/contracts/telemetry";
import { BrowserTelemetry } from "@executor-js/telemetry/browser";
import { RouterProvider } from "@tanstack/react-router";
import { hydrateStart } from "@tanstack/react-start/client";
import { hydrateRoot } from "react-dom/client";

const publicEmailPage = window.location.pathname.startsWith("/email/unsubscribe");
if (!publicEmailPage) {
  startAnalytics();
  void PageTelemetry.runPromise(
    Effect.flatMap(BrowserTelemetry, (telemetry) =>
      telemetry.navigation({ type: "load", path: window.location.pathname }),
    ),
  ).catch((error) => console.error(error));
}
if (Reflect.get(window, "$_TSR") === undefined) throw new Error("Dashboard document is incomplete");
const router = await hydrateStart();
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
}
if (import.meta.hot)
  import.meta.hot.dispose(() => {
    void PageTelemetry.dispose().catch((error) => console.error(error));
  });
hydrateRoot(document, <RouterProvider router={router} />, reactErrorHandlers);
