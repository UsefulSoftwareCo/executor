// First: the harness's outbound connect time-out (support/connect-timeout.ts).
import "./support/connect-timeout.ts";
import { expect } from "vitest";
import { configureLostConnections, installLostConnections } from "./support/lost-connections.ts";
import { installScenarioLifecycle } from "./support/lifecycle.ts";

// Stage requests lost on a reused connection before any response (support/lost-connections.ts).
// Each scenario's lifecycle names its stage's origins.
configureLostConnections({ origins: [], scenario: () => expect.getState().currentTestName });
installLostConnections();

installScenarioLifecycle();
