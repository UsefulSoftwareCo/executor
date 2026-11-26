import type { DashboardServer } from "@executor-js/dashboard-start/document";
import type { LocalDocumentContext } from "@executor-js/local-web/document";

declare const server: DashboardServer<LocalDocumentContext>;
export default server;
