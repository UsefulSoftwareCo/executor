/** Compile with the app's selected npm framework, or this Cloud deployment's default. */
import { compileWorkerApp } from "@executor-js/sdk/workerd/build";
import type { SourceFiles } from "@executor-js/sdk/core";
import server from "../../.generated/framework.json" with { type: "json" };
import browser from "../../.generated/browser-framework.json" with { type: "json" };
export const compileCloudApp = (files: SourceFiles) => compileWorkerApp(files, { server, browser });
