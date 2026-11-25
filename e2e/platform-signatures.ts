export const platformSignatures = {
  "runtime-502":
    "Cloudflare's Workers runtime answered 502 Bad Gateway itself; our Worker did not answer",
  lost: "Request lost before any response",
  "origin-unreachable":
    "No HTTPS connection to the scenario's app origin completed within the infrastructure wait",
} as const;
