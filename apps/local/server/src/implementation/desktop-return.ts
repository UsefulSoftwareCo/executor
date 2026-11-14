/**
 * Keep OAuth callbacks for Executor desktop, one authorization at a time. Only states the desktop
 * said it expects are kept; both lists are bounded and expire, and live only in this process.
 */
import { Clock, Duration, Effect, Option, Queue, Redacted, Ref } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import { PairingUnauthorized } from "../contracts/auth.ts";
import type { ServerConfig } from "../contracts/config.ts";
import { OAuthCallbackPath } from "../contracts/dashboard.ts";
import {
  DesktopReturnApi,
  desktopReturnHeader,
  desktopReturnLifetimeMillis,
  desktopReturnLimit,
  desktopReturnWaitMillis,
} from "../contracts/desktop-return.ts";
import { localBearer, localRequest } from "./auth.ts";

interface Kept {
  readonly url: Redacted.Redacted<string>;
  readonly expiresAt: number;
}

/** What the system browser shows once its callback is kept for the desktop. */
const returnPage = () =>
  HttpServerResponse.text(
    "<!doctype html><title>Executor</title><p>Return to Executor to finish connecting your account.</p>",
    {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
        "content-security-policy": "default-src 'none'",
      },
    },
  );

export const makeDesktopReturns = (
  config: Pick<ServerConfig, "port" | "browserOrigin" | "apiKey" | "password">,
) =>
  Effect.gen(function* () {
    const origin = `http://127.0.0.1:${config.port}`;
    /** Expected states and when each expires, oldest first. */
    const expected = yield* Ref.make<ReadonlyMap<string, number>>(new Map());
    const kept = yield* Queue.sliding<Kept>(desktopReturnLimit);

    const authorized = Effect.gen(function* () {
      const request = yield* localRequest(config.port, config.browserOrigin);
      if (
        request.headers.origin !== undefined ||
        !localBearer(config, request.headers.authorization)
      )
        return yield* new PairingUnauthorized();
    });

    const expect = (state: string) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        yield* Ref.update(expected, (entries) => {
          const next = new Map([...entries].filter(([, expiresAt]) => expiresAt > now));
          next.delete(state);
          // The oldest go to make room for this one; none while there is room.
          const excess = Math.max(0, next.size - desktopReturnLimit + 1);
          for (const oldest of [...next.keys()].slice(0, excess)) next.delete(oldest);
          return next.set(state, now + desktopReturnLifetimeMillis);
        });
      });

    /** Whether `state` was expected; it is expected only once. */
    const claim = (state: string) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        return yield* Ref.modify(expected, (entries) => {
          const expiresAt = entries.get(state);
          if (expiresAt === undefined || expiresAt <= now) return [false, entries] as const;
          const next = new Map(entries);
          next.delete(state);
          return [true, next] as const;
        });
      });

    const next = Effect.gen(function* () {
      const taken = yield* Queue.takeAll(kept).pipe(
        Effect.timeoutOption(Duration.millis(desktopReturnWaitMillis)),
      );
      const now = yield* Clock.currentTimeMillis;
      return {
        returns: Option.match(taken, {
          onNone: () => [],
          onSome: (all) =>
            all.filter((entry) => entry.expiresAt > now).map((entry) => ({ url: entry.url })),
        }),
      };
    });

    return {
      handlers: HttpApiBuilder.group(DesktopReturnApi, "desktopReturns", (handlers) =>
        handlers
          .handle("expect", ({ payload }) => authorized.pipe(Effect.andThen(expect(payload.state))))
          .handle("next", () => authorized.pipe(Effect.andThen(next))),
      ),
      /**
       * Serve the provider callback route. A browser callback for an expected state is kept for
       * the desktop; every other request, and the desktop's own load of a kept one, gets `page`.
       */
      callback: <E, R>(page: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          if (
            request.method !== "GET" ||
            request.headers.host !== new URL(origin).host ||
            request.headers[desktopReturnHeader] === "1" ||
            !request.url.startsWith("/") ||
            !URL.canParse(`${origin}${request.url}`)
          )
            return yield* page;
          const callback = new URL(`${origin}${request.url}`);
          const state = callback.searchParams.get("state");
          if (
            callback.origin !== origin ||
            callback.pathname !== OAuthCallbackPath ||
            state === null ||
            !(yield* claim(state))
          )
            return yield* page;
          const now = yield* Clock.currentTimeMillis;
          yield* Queue.offer(kept, {
            url: Redacted.make(callback.href),
            expiresAt: now + desktopReturnLifetimeMillis,
          });
          return returnPage();
        }),
    };
  });
