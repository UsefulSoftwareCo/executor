import type { HostPipeline } from "@executor-js/dashboard-start/in-process";
import type { Effect, Layer } from "effect";
import type { LocalAuth } from "../implementation/auth.ts";
import type { ServerConfig } from "./config.ts";
import type { HttpPlatform, HttpRouter, HttpServerResponse } from "effect/http";

export type LocalHttpHandler = Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  never,
  HttpRouter.Provided | HttpPlatform.HttpPlatform
>;

export interface LocalWeb {
  readonly document: Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    never,
    HttpRouter.Provided | HttpPlatform.HttpPlatform | HostPipeline
  >;
  readonly favicon: LocalHttpHandler;
  readonly asset: LocalHttpHandler;
  readonly fallback: LocalHttpHandler;
}

export interface LocalServerOptions {
  readonly product: "cli";
  readonly platform?: { readonly os: string; readonly arch: string } | undefined;
  readonly web?: LocalWeb | undefined;
  readonly devtools?: (
    auth: LocalAuth,
    settings: ServerConfig,
  ) => Layer.Layer<never, never, HttpRouter.HttpRouter>;
}
