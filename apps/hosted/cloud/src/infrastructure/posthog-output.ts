import type { Redacted } from "effect";

export interface PostHogOutput {
  readonly projectId: number;
  readonly proxyPath: string;
  readonly apiToken: Redacted.Redacted<string>;
  readonly uiHost: string;
  readonly apiHost: string;
}
