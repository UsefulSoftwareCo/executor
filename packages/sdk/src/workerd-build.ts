/** Worker-only compiler; its WASM dependency stays outside the runtime adapter module graph. */
export { compileWorkerApp, type WorkerFramework } from "./implementation/worker-build.ts";
export { browserBuild as workerBrowserBuild } from "./implementation/worker-browser-build.ts";
