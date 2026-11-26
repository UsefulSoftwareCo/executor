import type { DisplayFormat } from "@executor-js/ui/contracts/display";

export interface DocumentApi {
  readonly apiFetch: typeof globalThis.fetch;
  readonly path: string;
  readonly display: DisplayFormat;
}
