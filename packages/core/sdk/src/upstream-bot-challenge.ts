// Detecting an upstream bot-protection challenge. A site behind Cloudflare
// can answer an API request with a challenge page ("Just a moment...")
// instead of forwarding it: a Managed Challenge, JS challenge, or Bot Fight
// Mode verdict against the caller's network. Hosted executors send from
// datacenter or Workers egress, which is exactly the traffic those rules
// target, so a key that works from a laptop can be challenged here.
//
// The challenge is served by the edge BEFORE the request reaches the API, so
// the credential was never evaluated. Folding it into connection_rejected
// (whose recovery tells the agent to re-authenticate) sends the user off to
// rotate a key that is fine; the fix is on the API operator's side.
//
// Detection is deliberately strict: it keys off the `cf-mitigated: challenge`
// response header, which Cloudflare documents as the signal for a challenged
// request and which an origin cannot produce by accident. The HTML body is
// not inspected: a page that merely mentions Cloudflare never classifies. A
// miss is benign: the failure stays on its existing classification.

import { ToolResult } from "./tool-result";

export type BotChallengeDetection = {
  readonly provider: "cloudflare";
  /** Cloudflare's per-request Ray ID (`cf-ray`), which the site operator can
   *  look up in their Security Events to see which rule challenged it. */
  readonly rayId?: string;
};

const headerValue = (
  headers: Record<string, string> | undefined,
  name: string,
): string | undefined => {
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (key.toLowerCase() === name) return value;
  }
  return undefined;
};

/** Inspect an upstream response's headers for a bot-protection challenge.
 *  Returns `null` when nothing matches, so callers fall through to their
 *  existing classification. */
export const detectBotChallenge = (input: {
  readonly headers?: Record<string, string>;
}): BotChallengeDetection | null => {
  const mitigated = headerValue(input.headers, "cf-mitigated");
  if (mitigated?.trim().toLowerCase() !== "challenge") return null;
  const rayId = headerValue(input.headers, "cf-ray")?.trim();
  return { provider: "cloudflare", ...(rayId ? { rayId } : {}) };
};

/** One-line explanation of a challenged request, shared by tool failures and
 *  health-check details so both surfaces say the same thing. */
export const botChallengeMessage = (input: {
  readonly integration: string;
  readonly status: number;
  readonly detection: BotChallengeDetection;
}): string =>
  `Cloudflare bot protection in front of "${input.integration}" answered HTTP ${input.status} with a challenge (cf-mitigated: challenge${input.detection.rayId ? `, Ray ID ${input.detection.rayId}` : ""}), so the request never reached the API and the connection's credential was not checked. Re-authenticating will not help; the API operator must exempt API traffic from the challenge.`;

/** The tool result for a challenged request: a typed, non-authentication
 *  failure that carries the Ray ID instead of the challenge page's HTML. */
export const botChallengeToolFailure = <T = never>(input: {
  readonly integration: { readonly id: string; readonly scope?: string };
  readonly status: number;
  readonly detection: BotChallengeDetection;
}): ToolResult<T> =>
  ToolResult.fail({
    code: "upstream_bot_challenge",
    status: input.status,
    message: botChallengeMessage({
      integration: input.integration.id,
      status: input.status,
      detection: input.detection,
    }),
    // A challenge expects a browser to solve it; replaying the same request
    // from the same egress gets the same verdict.
    retryable: false,
    details: {
      category: "upstream_protection",
      integration: input.integration,
      upstream: {
        status: input.status,
        provider: input.detection.provider,
        mitigation: "challenge",
        ...(input.detection.rayId ? { rayId: input.detection.rayId } : {}),
      },
      recovery: {
        instructions:
          "The upstream's bot protection blocked this request before authentication, so the connection's credential is not the problem. Do not ask the user to re-enter or rotate it. Tell them the API operator has to allow API traffic past the challenge, and pass on the Ray ID so the operator can find the event.",
      },
    },
  });
