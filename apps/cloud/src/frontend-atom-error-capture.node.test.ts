import React from "react";
import { renderToString } from "react-dom/server";
import { RegistryProvider, useAtomSet } from "@effect/atom-react";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as AtomHttpApi from "effect/unstable/reactivity/AtomHttpApi";
import { FetchHttpClient } from "effect/unstable/http";
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import * as Schema from "effect/Schema";

const Widget = Schema.Struct({ name: Schema.String });

const WidgetGroup = HttpApiGroup.make("widgets").add(
  HttpApiEndpoint.get("load", "/widgets", {
    success: Widget,
  }),
);

const WidgetApi = HttpApi.make("widget-api").add(WidgetGroup);

const malformedWidgetFetch = () =>
  Promise.resolve(
    new Response(JSON.stringify({ name: 123 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );

const runAtomMutation = async (
  transformResponse?: (
    effect: Effect.Effect<unknown, unknown, unknown>,
  ) => Effect.Effect<unknown, unknown, unknown>,
) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = malformedWidgetFetch as typeof fetch;
  const WidgetClient = AtomHttpApi.Service<"WidgetClient">()("WidgetClient", {
    api: WidgetApi,
    baseUrl: "https://executor.test",
    httpClient: FetchHttpClient.layer,
    ...(transformResponse ? { transformResponse } : {}),
  });
  const loadWidget = WidgetClient.mutation("widgets", "load");
  let runLoad: ((input: {}) => Promise<Exit.Exit<unknown, unknown>>) | undefined;

  function CaptureMutation() {
    runLoad = useAtomSet(loadWidget, { mode: "promiseExit" });
    return null;
  }

  renderToString(React.createElement(RegistryProvider, null, React.createElement(CaptureMutation)));

  const exit = await runLoad!({});
  globalThis.fetch = originalFetch;
  return exit;
};

describe("AtomHttpApi frontend decode failures", () => {
  it("returns malformed success responses as failed exits in promiseExit mode", async () => {
    const exit = await runAtomMutation();

    expect(Exit.isFailure(exit)).toBe(true);
  });

  it("can report malformed success responses once through transformResponse", async () => {
    const captured: unknown[] = [];
    const exit = await runAtomMutation((effect) =>
      Effect.tapCause(effect, (cause) => Effect.sync(() => captured.push(cause))),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    expect(captured).toHaveLength(1);
  });
});
