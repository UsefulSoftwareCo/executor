/** Cloud supplies the browser framework built with the deployed host. */
import { workerBrowserBuild } from "@executor-js/sdk/workerd/build";
import framework from "../../.generated/browser-framework.json" with { type: "json" };
export const browserBuild = (
  ...args: [
    Parameters<typeof workerBrowserBuild>[0],
    Parameters<typeof workerBrowserBuild>[1],
    Parameters<typeof workerBrowserBuild>[2],
  ]
) => workerBrowserBuild(...args, framework);
