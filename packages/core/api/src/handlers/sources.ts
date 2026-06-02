import { HttpApiBuilder } from "effect/unstable/httpapi";
import { Effect } from "effect";
import { ScopeId, ToolId } from "@executor-js/sdk";
import type {
  RemoveSourceCredentialBindingInput,
  ReplaceSourceCredentialBindingsInput,
  SetSourceCredentialBindingInput,
} from "@executor-js/sdk/shared";

import { ExecutorApi } from "../api";
import { ExecutorService } from "../services";
import { capture } from "@executor-js/api";

export const SourcesHandlers = HttpApiBuilder.group(ExecutorApi, "sources", (handlers) =>
  handlers
    .handle(
      "list",
      Effect.fn("sources.list")(function* () {
        return yield* capture(
          Effect.gen(function* () {
            const executor = yield* ExecutorService;
            const sources = yield* executor.sources.list();
            return sources.map((s) => ({
              id: s.id,
              scopeId: s.scopeId ? ScopeId.make(s.scopeId) : undefined,
              name: s.name,
              kind: s.kind,
              url: s.url,
              runtime: s.runtime,
              canRemove: s.canRemove,
              canRefresh: s.canRefresh,
              canEdit: s.canEdit,
              connectionIds: s.connectionIds,
            }));
          }),
        );
      }),
    )
    .handle(
      "remove",
      Effect.fn("sources.remove")(function* (ctx: {
        params: { scopeId: ScopeId; sourceId: string };
      }) {
        return yield* capture(
          Effect.gen(function* () {
            const executor = yield* ExecutorService;
            yield* executor.sources.remove({
              id: ctx.params.sourceId,
              targetScope: ctx.params.scopeId,
            });
            return { removed: true };
          }),
        );
      }),
    )
    .handle(
      "refresh",
      Effect.fn("sources.refresh")(function* (ctx: {
        params: { scopeId: ScopeId; sourceId: string };
      }) {
        return yield* capture(
          Effect.gen(function* () {
            const executor = yield* ExecutorService;
            yield* executor.sources.refresh({
              id: ctx.params.sourceId,
              targetScope: ctx.params.scopeId,
            });
            return { refreshed: true };
          }),
        );
      }),
    )
    .handle(
      "tools",
      Effect.fn("sources.tools")(function* (ctx: { params: { sourceId: string } }) {
        return yield* capture(
          Effect.gen(function* () {
            const executor = yield* ExecutorService;
            // Source detail is a management view — include policy-blocked
            // tools so users can see and unblock them from the same place
            // they review the source's other tools. Annotations are loaded
            // so the UI can show the plugin's default approval state for
            // tools that have no user policy override.
            const tools = yield* executor.tools.list({
              sourceId: ctx.params.sourceId,
              includeAnnotations: true,
              includeBlocked: true,
            });
            return tools.map((t) => ({
              id: ToolId.make(t.id),
              pluginId: t.pluginId,
              sourceId: t.sourceId,
              name: t.name,
              description: t.description,
              mayElicit: t.annotations?.mayElicit,
              requiresApproval: t.annotations?.requiresApproval,
              approvalDescription: t.annotations?.approvalDescription,
            }));
          }),
        );
      }),
    )
    .handle(
      "detect",
      Effect.fn("sources.detect")(function* (ctx: { payload: { url: string } }) {
        return yield* capture(
          Effect.gen(function* () {
            const executor = yield* ExecutorService;
            const results = yield* executor.sources.detect(ctx.payload.url.trim());
            return results.map((r) => ({
              kind: r.kind,
              confidence: r.confidence,
              endpoint: r.endpoint,
              name: r.name,
              namespace: r.namespace,
            }));
          }),
        );
      }),
    )
    .handle(
      "configure",
      Effect.fn("sources.configure")(function* (ctx: {
        params: { scopeId: ScopeId };
        payload: {
          source: { id: string; scope: ScopeId };
          scope?: ScopeId;
          type?: string;
          config: unknown;
        };
      }) {
        return yield* capture(
          Effect.gen(function* () {
            const executor = yield* ExecutorService;
            return yield* executor.sources.configure({
              source: ctx.payload.source,
              scope: ctx.payload.scope ?? ctx.params.scopeId,
              type: ctx.payload.type,
              config: ctx.payload.config,
            });
          }),
        );
      }),
    )
    .handle(
      "listBindings",
      Effect.fn("sources.listBindings")(function* (ctx: {
        params: { sourceId: string; sourceScopeId: ScopeId };
      }) {
        return yield* capture(
          Effect.gen(function* () {
            const executor = yield* ExecutorService;
            return yield* executor.sources.listBindings({
              source: {
                id: ctx.params.sourceId,
                scope: ctx.params.sourceScopeId,
              },
            });
          }),
        );
      }),
    )
    .handle(
      "setBinding",
      Effect.fn("sources.setBinding")(function* (ctx: {
        payload: SetSourceCredentialBindingInput;
      }) {
        return yield* capture(
          Effect.gen(function* () {
            const executor = yield* ExecutorService;
            return yield* executor.sources.setBinding(ctx.payload);
          }),
        );
      }),
    )
    .handle(
      "removeBinding",
      Effect.fn("sources.removeBinding")(function* (ctx: {
        payload: RemoveSourceCredentialBindingInput;
      }) {
        return yield* capture(
          Effect.gen(function* () {
            const executor = yield* ExecutorService;
            yield* executor.sources.removeBinding(ctx.payload);
            return { removed: true };
          }),
        );
      }),
    )
    .handle(
      "replaceBindings",
      Effect.fn("sources.replaceBindings")(function* (ctx: {
        payload: ReplaceSourceCredentialBindingsInput;
      }) {
        return yield* capture(
          Effect.gen(function* () {
            const executor = yield* ExecutorService;
            return yield* executor.sources.replaceBindings(ctx.payload);
          }),
        );
      }),
    ),
);
