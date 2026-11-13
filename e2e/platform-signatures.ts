/**
 * The first words of a failure that came from Cloudflare's platform rather than from our Worker
 * (`e2e/support/request-failure.ts` decides which failures are exactly one of these). Cloud tests
 * on main counts each in its coverage summary (`e2e/ci-selection.ts`, `verify deployed`).
 */
export const platformSignatures = {
  "runtime-502":
    "Cloudflare's Workers runtime answered 502 Bad Gateway itself; our Worker did not answer",
  lost: "Request lost before any response",
} as const;
