import { Layer } from "effect";
import { requireUserLive } from "./auth.ts";
import { requireOrganizationLive } from "./organization.ts";
import { requireAccountTargetLive } from "./proofs/account-access.ts";
import { batchAuthentication } from "./batch-authentication.ts";

/**
 * Every hosted API middleware implementation. Hosts provide this once where they build the API;
 * a new middleware joins here rather than in each host.
 */
export const hostedMiddlewareLive = Layer.mergeAll(
  requireUserLive,
  requireOrganizationLive,
  requireAccountTargetLive,
  batchAuthentication.layer,
);
