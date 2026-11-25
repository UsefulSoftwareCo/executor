import { setDefaultAutoSelectFamilyAttemptTimeout } from "node:net";

export const connectAttemptMs = 2_500;

setDefaultAutoSelectFamilyAttemptTimeout(connectAttemptMs);
