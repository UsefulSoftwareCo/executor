import { Layer } from "effect";
import { requireBrowserSessionLive } from "./auth.ts";
import { requireOrganizationLive } from "./organization.ts";
import { requireAccountTargetLive } from "./proofs/account-access.ts";
import { batchAuthentication } from "./batch-authentication.ts";

export const hostedMiddlewareLive = Layer.mergeAll(
  requireBrowserSessionLive,
  requireOrganizationLive,
  requireAccountTargetLive,
  batchAuthentication.layer,
);
