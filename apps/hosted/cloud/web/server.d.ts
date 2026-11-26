import type { DashboardServer } from "@executor-js/dashboard-start/document";
import type { CloudDocumentContext } from "@executor-js/hosted-cloud-web/document";

declare const server: DashboardServer<CloudDocumentContext>;
export default server;
