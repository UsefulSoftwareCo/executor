import { createStartHandler } from "@tanstack/react-start/server";
import { completeDocumentHandler } from "@executor-js/dashboard-start/complete-document";

export default { fetch: createStartHandler(completeDocumentHandler) };
