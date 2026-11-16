// First: the harness's outbound connect time-out (support/connect-timeout.ts).
import "./support/connect-timeout.ts";
// Second: each stage request on a connection of its own (support/stage-connections.ts).
import "./support/stage-connections.ts";
import { expect } from "vitest";
import { configureLostConnections } from "./support/lost-connections.ts";
import { installLostRequestSaving, installScenarioLifecycle } from "./support/lifecycle.ts";

// Stage requests lost on a reused connection before any response (support/lost-connections.ts).
// Each scenario's lifecycle names its stage's origins; records name their scenario and test file.
configureLostConnections({
  origins: [],
  scenario: () => expect.getState().currentTestName,
  file: () => expect.getState().testPath?.split("/").at(-1),
});
installLostRequestSaving();

installScenarioLifecycle();
