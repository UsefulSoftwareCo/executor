/** One page-owned telemetry runtime shared by both hosted dashboards. */
import { browserSettings, makeBrowserTelemetry } from "@executor-js/telemetry/browser";
import { Layer } from "effect";
const telemetry = makeBrowserTelemetry(browserSettings("/api/telemetry", "executor-hosted-web"));
export const DashboardRuntime = telemetry.atoms;
export const PageTelemetry = telemetry.runtime;
export const BrowserAtoms = DashboardRuntime(Layer.empty);
