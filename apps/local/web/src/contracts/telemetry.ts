import { browserSettings, makeBrowserTelemetry } from "@executor-js/telemetry/browser";
import { dashboardAtoms } from "@executor-js/dashboard-start/api";
import { Layer } from "effect";
const telemetry = makeBrowserTelemetry(
  browserSettings("/dashboard/api/telemetry", "executor-local-web"),
);
export const DashboardRuntime = dashboardAtoms(telemetry.atoms);
export const PageTelemetry = telemetry.runtime;
export const BrowserAtoms = DashboardRuntime(Layer.empty);
