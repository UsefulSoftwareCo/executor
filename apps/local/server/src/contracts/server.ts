/** Local host extension points. Runtime adapters supply behavior, not URL dispatch. */
import type { HostPipeline } from "@executor-js/dashboard-start/in-process";
import type { Effect, Layer } from "effect";
import type { LocalAuth } from "../implementation/auth.ts";
import type { ServerConfig } from "./config.ts";
import type { HttpPlatform, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

/** Wrap an HTTP handler while preserving its errors and required services. */
export type LocalHttpMiddleware = <E, R>(
  handler: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
) => Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  E,
  R | HttpServerRequest.HttpServerRequest
>;

/** Customize only the already-matched provider callback; origin comes from the bound listener. */
export type LocalOAuthCallback = (origin: string) => LocalHttpMiddleware;

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

/** The product and optional adapters owned by the CLI or desktop composition. */
export interface LocalServerOptions {
  /** The product reported by analytics: the CLI or the desktop backend. */
  readonly product: "cli" | "desktop";
  /** The Node edge supplies its platform names for analytics. */
  readonly platform?: { readonly os: string; readonly arch: string } | undefined;
  readonly oauthCallback?: LocalOAuthCallback | undefined;
  readonly web?: LocalWeb | undefined;
  /** Only the development entry point supplies local session shortcuts. */
  readonly devtools?: (
    auth: LocalAuth,
    settings: ServerConfig,
  ) => Layer.Layer<never, never, HttpRouter.HttpRouter>;
}
