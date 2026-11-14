/** Local host extension points. Runtime adapters supply behavior, not URL dispatch. */
import type { HostPipeline } from "@executor-js/dashboard-start/in-process";
import type { Effect, Layer } from "effect";
import type { LocalAuth } from "../implementation/auth.ts";
import type { ServerConfig } from "./config.ts";
import type { HttpPlatform, HttpRouter, HttpServerResponse } from "effect/http";

/** A request handler mounted by the local server's native route table. */
export type LocalHttpHandler = Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  never,
  HttpRouter.Provided | HttpPlatform.HttpPlatform
>;

/** Static or development web capabilities; neither adapter chooses product routes. */
export interface LocalWeb {
  /** Rendered pages read the product API in-process through the host pipeline. */
  readonly document: Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    never,
    HttpRouter.Provided | HttpPlatform.HttpPlatform | HostPipeline
  >;
  readonly favicon: LocalHttpHandler;
  readonly asset: LocalHttpHandler;
  readonly fallback: LocalHttpHandler;
}

/** The product and optional adapters owned by the CLI composition. */
export interface LocalServerOptions {
  /**
   * The product reported by analytics. Every local server is the CLI's, including the background
   * server Executor desktop joins.
   */
  readonly product: "cli";
  /** The Node edge supplies its platform names for analytics. */
  readonly platform?: { readonly os: string; readonly arch: string } | undefined;
  readonly web?: LocalWeb | undefined;
  /** Only the development entry point supplies local session shortcuts. */
  readonly devtools?: (
    auth: LocalAuth,
    settings: ServerConfig,
  ) => Layer.Layer<never, never, HttpRouter.HttpRouter>;
}
