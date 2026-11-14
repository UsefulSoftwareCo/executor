/**
 * The first words of a failure that came from Cloudflare's platform rather than from our Worker
 * (`e2e/support/request-failure.ts` decides which failures are exactly one of these). Cloud tests
 * on main counts each in its coverage summary (`e2e/ci-selection.ts`, `verify deployed`).
 */
export const platformSignatures = {
  "runtime-502":
    "Cloudflare's Workers runtime answered 502 Bad Gateway itself; our Worker did not answer",
  lost: "Request lost before any response",
  /**
   * Preparation: a team origin with which no HTTPS connection completed within the wait, so its
   * certificate never became usable in time. Not an origin that answered and was not reported
   * ready by the domain coordinator, which may be ours and keeps its own text.
   */
  "origin-unreachable":
    "No HTTPS connection to the scenario's app origin completed within the infrastructure wait",
} as const;
