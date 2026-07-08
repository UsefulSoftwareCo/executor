/* oxlint-disable executor/no-unknown-error-message -- boundary: SyncDiagnostic intentionally serializes typed source and publish error messages */
import { Data, Effect } from "effect";

import { PublishError, type PublishFile } from "../pipeline/publish";
import { redactUrl } from "../git-client/url-security";

export interface AppSourceSnapshot {
  readonly files: readonly PublishFile[];
  readonly sourceRef: string;
  readonly description?: string;
}

export interface AppSource {
  readonly fetch: () => Effect.Effect<AppSourceSnapshot, AppSourceError | PublishError>;
}

export class AppSourceError extends Data.TaggedError("AppSourceError")<{
  readonly message: string;
  readonly path?: string;
  readonly status?: number;
  readonly cause?: unknown;
}> {}

export interface SyncDiagnostic {
  readonly stage: "source" | "discover" | "bundle" | "collect" | "project";
  readonly message: string;
  readonly diagnostics?: readonly { readonly path: string; readonly message: string }[];
}

export const sourceErrorToDiagnostic = (error: AppSourceError): SyncDiagnostic => ({
  stage: "source",
  message: error.message,
  ...(error.path ? { diagnostics: [{ path: redactUrl(error.path), message: error.message }] } : {}),
});

export const publishErrorToDiagnostic = (error: PublishError): SyncDiagnostic => ({
  stage: error.stage,
  message: error.message,
  diagnostics: error.diagnostics,
});
