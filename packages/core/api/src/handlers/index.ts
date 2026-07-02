import { Layer } from "effect";

import { ToolsHandlers } from "./tools";
import { IntegrationsHandlers } from "./integrations";
import { ConnectionsHandlers } from "./connections";
import { ProvidersHandlers } from "./providers";
import { ExecutionsHandlers } from "./executions";
import { OAuthHandlers } from "./oauth";
import { PoliciesHandlers } from "./policies";

export { ToolsHandlers } from "./tools";
export { IntegrationsHandlers } from "./integrations";
export { ConnectionsHandlers } from "./connections";
export { ProvidersHandlers } from "./providers";
export { ExecutionsHandlers } from "./executions";
export { OAuthHandlers } from "./oauth";
export { PoliciesHandlers } from "./policies";

export const CoreHandlers = Layer.mergeAll(
  ToolsHandlers,
  IntegrationsHandlers,
  ConnectionsHandlers,
  ProvidersHandlers,
  ExecutionsHandlers,
  OAuthHandlers,
  PoliciesHandlers,
);
