// Selfhost-only (runs on the dev server AND the production Docker image): the
// update card paints on the self-host web shell. See
// ../src/update-card-render.ts for the shared body.
import {
  registerUpdateCardCurrentScenario,
  registerUpdateCardRenderScenario,
} from "../src/update-card-render";

registerUpdateCardRenderScenario(
  "Selfhost · the web shell sidebar surfaces the update-available card",
);

registerUpdateCardCurrentScenario(
  "Selfhost · no update card when current, and the footer shows the version",
);
