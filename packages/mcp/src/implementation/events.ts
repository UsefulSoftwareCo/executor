/**
 * MCP events: `events/list`, `events/subscribe` and `events/unsubscribe` over the caller's backend.
 * An event is named `<app slug>.<event>`. Its subscription arguments are the event's filters,
 * each optional. Webhook delivery is the only mode.
 */
import { Effect, Match, Predicate, Redacted, Schema } from "effect";
import { McpSchema, type McpServer } from "effect/ai";
import { EventArguments, type AppEventDefinition } from "@executor-js/sdk/core";
import type { McpBackend, McpEventError, McpEventKey } from "../contracts/backend.ts";

/** Subscription arguments: the filters, every one optional, nothing else. */
const inputSchema = (
  filters: AppEventDefinition["filters"],
): McpSchema.EventDefinition["inputSchema"] => {
  const { required: _required, ...rest } = filters;
  return { ...rest, type: "object", additionalProperties: false };
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
  const key = (params: {
    readonly name: string;
    readonly arguments?: Readonly<Record<string, Schema.Json>> | undefined;
    readonly delivery: { readonly url: string };
  }) =>
    decodeArguments(params.arguments).pipe(
      Effect.map((args): McpEventKey => ({
        name: params.name,
        callbackUrl: params.delivery.url,
        arguments: args,
      })),
    );
  return {
    list: () =>
      Effect.gen(function* () {
        const apps = yield* backend.listApps();
        const pages = yield* Effect.forEach(
          apps,
          (app) =>
            backend.eventDefinitions({ app: app.id }).pipe(
              Effect.map((definitions) =>
                definitions.map((definition): McpSchema.EventDefinition => ({
                  name: `${app.slug}.${definition.name}`,
                  title: `${app.name}: ${definition.name}`,
                  description: definition.description,
                  delivery: ["webhook"],
                  inputSchema: inputSchema(definition.filters),
                  payloadSchema: definition.payload,
                })),
              ),
              // Refusals leave the app out; storage and other failures fail the listing, so a
              // client never mistakes an outage for events that were removed.
              Effect.catchIf(
                (error) =>
                  Predicate.isTagged(error, "GrantForbidden") ||
                  Predicate.isTagged(error, "OrganizationForbidden") ||
                  Predicate.isTagged(error, "AppNotFound"),
                () => Effect.succeed([]),
              ),
            ),
          { concurrency: 8 },
        );
        return { events: pages.flat() };
      }).pipe(Effect.mapError(projectError), Effect.withSpan("mcp.events.list")),
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
        const target =
          existing === null
            ? yield* resolve(params.name)
            : { app: existing.app, event: existing.event };
        if (target === undefined)
          return yield* Effect.fail(
            mcpError(McpSchema.NOT_FOUND_ERROR_CODE, "No event with this name", {
              kind: "event",
            }),
          );
        const granted = yield* backend.subscribeEvent({
          key: subscription,
          target,
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
        Effect.withSpan("mcp.events.subscribe"),
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
        Effect.withSpan("mcp.events.unsubscribe"),
      ),
  };
};
