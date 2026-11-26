import type { DashboardServer } from "@executor-js/dashboard-start/document";
import type { SelfHostDocumentContext } from "@executor-js/hosted-self-host-web/document";

declare const server: DashboardServer<SelfHostDocumentContext>;
export default server;
