import type { CloudDocumentContext } from "@executor-js/hosted-cloud-web/document";
import type { RpcCallError } from "alchemy/Rpc";
import type { Effect } from "effect";

export type DocumentRead = (
  url: string,
  init: {
    readonly method: string;
    readonly headers: ReadonlyArray<readonly [string, string]>;
  },
) => Promise<Response>;

export type DocumentRenderContext = Omit<CloudDocumentContext, "apiFetch">;

export type DashboardRenderer = {
  readonly render: (
    request: Request,
    context: DocumentRenderContext,
    read: DocumentRead,
  ) => Effect.Effect<Response, RpcCallError>;
};
