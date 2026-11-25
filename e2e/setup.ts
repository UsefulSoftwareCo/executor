import "./support/connect-timeout.ts";
import "./support/stage-connections.ts";
import { expect } from "vitest";
import { configureLostConnections } from "./support/lost-connections.ts";
import { installLostRequestSaving, installScenarioLifecycle } from "./support/lifecycle.ts";
import { installSnapshotFailures } from "./support/snapshot-failures.ts";

configureLostConnections({
  origins: [],
  scenario: () => expect.getState().currentTestName,
  file: () => expect.getState().testPath?.split("/").at(-1),
});
installLostRequestSaving();

installScenarioLifecycle();
installSnapshotFailures();
