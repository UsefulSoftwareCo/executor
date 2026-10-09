/** Browser entry; the document itself is rendered by the local server. */
import { PageTelemetry } from "./contracts/telemetry.ts";
import { BrowserTelemetry } from "@executor-js/telemetry/browser";
import { Effect } from "effect";
import { RouterProvider } from "@tanstack/react-router";
import { hydrateStart } from "@tanstack/react-start/client";
import { hydrateRoot } from "react-dom/client";

// Start page-owned listeners independently of component query lifetimes.
void PageTelemetry.runPromise(
  Effect.flatMap(BrowserTelemetry, (telemetry) =>
    telemetry.navigation({ type: "load", path: window.location.pathname }),
  ),
).catch((error) => console.error(error));
const router = await hydrateStart();
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
if (import.meta.hot)
  import.meta.hot.dispose(() => {
    void PageTelemetry.dispose().catch((error) => console.error(error));
  });
hydrateRoot(document, <RouterProvider router={router} />);
