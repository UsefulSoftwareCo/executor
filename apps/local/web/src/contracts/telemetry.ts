/** One page-owned telemetry runtime shared by local dashboard atoms. */
import { browserSettings, makeBrowserTelemetry } from "@executor-js/telemetry/browser";
import { Layer } from "effect";
const telemetry = makeBrowserTelemetry(
  browserSettings("/dashboard/api/telemetry", "executor-local-web"),
);
export const DashboardRuntime = telemetry.atoms;
export const PageTelemetry = telemetry.runtime;
export const BrowserAtoms = DashboardRuntime(Layer.empty);
