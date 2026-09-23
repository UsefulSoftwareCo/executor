import { defineApp } from "apps";
import { requirements } from "./context.ts";
import { listReports, saveReport, startReport, reportRuns } from "./operations.ts";
import { report } from "./workflows.ts";
export default defineApp(requirements, {
  queries: { listReports, reportRuns },
  mutations: { saveReport, startReport },
  workflows: { report },
});
