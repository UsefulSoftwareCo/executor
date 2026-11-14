/**
 * MCP events: `events/list`, `events/subscribe` and `events/unsubscribe` over the caller's backend.
 * Webhook delivery is the only mode.
 *
 * `events/list` returns one event, {@link appEventName}, the same for every caller. Clients such as
 * ChatGPT save the list once, when the server is scanned, and offer it to every user; a list of
 * the caller's own apps would offer one user's events to everyone, and none of theirs. Its
 * arguments select the events: an app's slug and one of its events, the slug alone for all of the
 * app's events, or nothing for every event of every app the connection can use. With an app and an
 * event, that event's filters may be added. Each delivery carries `{ app, event, data }`.
 *
 * An app's event can also be subscribed to by its own name, `<app slug>.<event>`, with its filters
 * as the arguments; subscriptions made that way keep refreshing.
 */
import { Effect, Match, Predicate, Redacted, Schema } from "effect";
import { McpSchema, type McpServer } from "effect/ai";
import { EventArguments } from "@executor-js/sdk/core";
import type {
  McpBackend,
  McpEventError,
  McpEventKey,
  McpEventTarget,
} from "../contracts/backend.ts";
import { withOperationSpan } from "./telemetry.ts";

/** The one listed event. Apps cannot declare it: an app's events need its slug before the dot. */
export const appEventName = "executor.app_event";

const appEventDefinition: McpSchema.EventDefinition = {
  name: appEventName,
  title: "Executor app events",
  description:
    "Events from the user's Executor apps. With no arguments, every event of every app this connection can use, including apps added later. Set app to an app's slug, such as minecraft-watch, for only its events, and event as well, such as server.offline, for only that one. With both, that event's own filters may be added as further arguments. Prefer the narrowest selection the user asked for: every delivery reaches this chat. Each delivery's data is { app, event, data }.",
  delivery: ["webhook"],
  inputSchema: {
    type: "object",
    properties: {
      app: {
        type: "string",
        description: "The app's slug. Omit it to receive every app's events.",
      },
      event: {
        type: "string",
        description: "One event the app declares. Omit it for all of the app's events. Needs app.",
      },
    },
    additionalProperties: {
      type: ["string", "number", "boolean"],
      description: "A filter the selected event declares. Needs app and event.",
    },
  },
  payloadSchema: {
    type: "object",
    properties: {
      app: { type: "string", description: "The slug of the app that emitted the event." },
      event: { type: "string", description: "The event's name within the app." },
      data: { description: "The event's data, as the app declares it." },
    },
    required: ["app", "event", "data"],
    additionalProperties: false,
  },
};

const mcpError = (code: number, message: string, data?: Schema.Json) =>
  new McpSchema.McpErrorBase({ code, message, ...(data === undefined ? {} : { data }) });

/** Map a refusal to its draft-extension error. Other failures keep no detail beyond a safe message. */
const projectError = (error: unknown) =>
  Predicate.isTagged(error, "EventNotFound") ||
  Predicate.isTagged(error, "EventDefinitionChanged") ||
  Predicate.isTagged(error, "EventSubscriptionInvalid") ||
  Predicate.isTagged(error, "EventCallbackFailed") ||
  Predicate.isTagged(error, "EventsUnavailable")
    ? Match.value(error as McpEventError).pipe(
        Match.tagsExhaustive({
          EventNotFound: ({ kind }) =>
            mcpError(
              McpSchema.NOT_FOUND_ERROR_CODE,
              kind === "event" ? "No event with this name" : "No subscription with this key",
              { kind },
            ),
          // A refresh whose arguments name filters the event no longer declares: the draft's
          // in-place schema change. The subscription has been stopped.
          EventDefinitionChanged: () =>
            mcpError(
              McpSchema.UNSUPPORTED_ERROR_CODE,
              "This event's arguments changed; list events and subscribe again",
              { feature: "inputSchema", reason: "schema_changed" },
            ),
          EventSubscriptionInvalid: ({ field, message }) =>
            mcpError(McpSchema.INVALID_PARAMS_ERROR_CODE, message, { field }),
          EventCallbackFailed: ({ reason }) =>
            mcpError(
              McpSchema.CALLBACK_ENDPOINT_ERROR_CODE,
              "The callback endpoint failed verification",
              {
                reason,
              },
            ),
          EventsUnavailable: () =>
            mcpError(McpSchema.UNSUPPORTED_ERROR_CODE, "This server cannot deliver events", {
              feature: "deliveryMode",
              value: "webhook",
            }),
        }),
      )
    : Predicate.isTagged(error, "GrantForbidden") || Predicate.isTagged(error, "Forbidden")
      ? mcpError(McpSchema.FORBIDDEN_ERROR_CODE, "This connection may not use this event")
      : mcpError(McpSchema.INTERNAL_ERROR_CODE, "The event request failed");

const decodeArguments = (value: unknown) =>
  Schema.decodeUnknownEffect(EventArguments)(value ?? {}).pipe(
    Effect.mapError(() =>
      mcpError(
        McpSchema.INVALID_PARAMS_ERROR_CODE,
        "Event arguments are filter values: strings, numbers or booleans",
        { field: "arguments" },
      ),
    ),
  );

/** Events handlers for one product's backend. The backend authorizes each operation. */
export const eventsHandler = (backend: McpBackend<Error>): McpServer.EventsHandler => {
  /** The app and event a name refers to now, among the apps this caller can reach. */
  const resolve = (name: string) =>
    Effect.gen(function* () {
      const separator = name.indexOf(".");
      if (separator <= 0) return undefined;
      const slug = name.slice(0, separator);
      const event = name.slice(separator + 1);
      const app = (yield* backend.listApps()).find((candidate) => candidate.slug === slug);
      return app === undefined ? undefined : { app: app.id, event };
    });
  /**
   * The subscription key. For {@link appEventName}, `app` and `event` leave the arguments for the
   * selection, which is part of the key, and the rest are the selected event's filters.
   */
  const key = (params: {
    readonly name: string;
    readonly arguments?: Readonly<Record<string, Schema.Json>> | undefined;
    readonly delivery: { readonly url: string };
  }) =>
    Effect.gen(function* () {
      const args = yield* decodeArguments(params.arguments);
      if (params.name !== appEventName)
        return {
          name: params.name,
          callbackUrl: params.delivery.url,
          arguments: args,
        } satisfies McpEventKey;
      const { app, event, ...filters } = args;
      if (
        (app !== undefined && (typeof app !== "string" || app === "")) ||
        (event !== undefined && (typeof event !== "string" || event === "")) ||
        (event !== undefined && app === undefined)
      )
        return yield* Effect.fail(
          mcpError(
            McpSchema.INVALID_PARAMS_ERROR_CODE,
            "app is an app's slug and event one of its events; event needs app",
            { field: "arguments" },
          ),
        );
      return {
        name: params.name,
        callbackUrl: params.delivery.url,
        arguments: filters,
        selection: {
          ...(app === undefined ? {} : { app }),
          ...(event === undefined ? {} : { event }),
        },
      } satisfies McpEventKey;
    });
  /** The events a new subscription's key refers to now, among the apps this caller can reach. */
  const target = (subscription: McpEventKey) =>
    Effect.gen(function* () {
      const selection = subscription.selection;
      if (selection === undefined) return yield* resolve(subscription.name);
      if (selection.app === undefined) return { app: null, event: null } as const;
      const app = (yield* backend.listApps()).find((candidate) => candidate.slug === selection.app);
      return app === undefined ? undefined : { app: app.id, event: selection.event ?? null };
    });
  return {
    list: () =>
      Effect.succeed({ events: [appEventDefinition] }).pipe(withOperationSpan("mcp.events.list")),
    subscribe: (params) =>
      Effect.gen(function* () {
        if (params.delivery.mode !== "webhook")
          return yield* Effect.fail(
            mcpError(McpSchema.UNSUPPORTED_ERROR_CODE, "Only webhook delivery is supported", {
              feature: "deliveryMode",
              value: params.delivery.mode,
            }),
          );
        if (params.cursor !== undefined && params.cursor !== null)
          return yield* Effect.fail(
            mcpError(
              McpSchema.UNSUPPORTED_ERROR_CODE,
              "These events do not support replay from a cursor",
              { feature: "cursor" },
            ),
          );
        const subscription = yield* key(params);
        // A saved subscription keeps its app and event, so its refreshes still work after the
        // app's slug changes. The SDK checks it against the current declaration.
        const existing = yield* backend.findEventSubscription(subscription);
        const selected: McpEventTarget | undefined =
          existing === null
            ? yield* target(subscription)
            : existing.app === null
              ? { app: null, event: null }
              : { app: existing.app, event: existing.event };
        if (selected === undefined)
          return yield* Effect.fail(
            mcpError(McpSchema.NOT_FOUND_ERROR_CODE, "No event with this name", {
              kind: "event",
            }),
          );
        const granted = yield* backend.subscribeEvent({
          key: subscription,
          target: selected,
          secret: Redacted.make(params.delivery.secret),
          ...(params.ttlMs === undefined ? {} : { ttlMs: params.ttlMs }),
        });
        return {
          id: granted.id,
          refreshBefore: granted.refreshBefore.toISOString(),
          cursor: null,
          truncated: false,
        };
      }).pipe(
        Effect.mapError((error) =>
          Schema.is(McpSchema.McpErrorBase)(error) ? error : projectError(error),
        ),
        withOperationSpan("mcp.events.subscribe"),
      ),
    unsubscribe: (params) =>
      Effect.gen(function* () {
        const subscription = yield* key(params);
        const existing = yield* backend.findEventSubscription(subscription);
        // Unsubscribing what does not exist, or no longer exists, succeeds.
        if (existing === null) return;
        yield* backend.unsubscribeEvent({ app: existing.app, key: subscription });
      }).pipe(
        Effect.mapError((error) =>
          Schema.is(McpSchema.McpErrorBase)(error) ? error : projectError(error),
        ),
        withOperationSpan("mcp.events.unsubscribe"),
      ),
  };
};
