/** Public ingestion configuration exported by the persistent PostHog Alchemy stack. */
import type { Redacted } from "effect";

/** The management credential is deliberately absent from stack outputs. */
export interface PostHogOutput {
  readonly projectId: number;
  readonly heroExperimentId: number;
  readonly proxyPath: string;
  readonly apiToken: Redacted.Redacted<string>;
  readonly uiHost: string;
  readonly apiHost: string;
}
