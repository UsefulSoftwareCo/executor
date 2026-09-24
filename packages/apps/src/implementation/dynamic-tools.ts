/** Author-facing lazy sources adapt once to the framework's Effect execution path. */
import { Effect, Schema } from "effect";
import { HostedTool } from "../contracts/host.ts";
import type { DynamicTools } from "../contracts/dynamic-tools.ts";
import { fromPromise } from "./authoring.ts";
import { nativeOperation, type OperationDeclaration } from "./operations.ts";

/** Declare metadata discovery separately from executable resolution. Names are fully qualified. */
export const dynamicTools = (source: {
  readonly list: () => Promise<readonly HostedTool[]>;
  readonly resolve: (
    name: string,
  ) => Promise<OperationDeclaration<"query" | "mutation"> | undefined>;
}): DynamicTools => ({
  list: () =>
    fromPromise(source.list)().pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(HostedTool))),
    ),
  resolve: (name) =>
    fromPromise(source.resolve)(name).pipe(
      Effect.map((value) => {
        if (value === undefined) return undefined;
        const operation = nativeOperation(value);
        if (operation === undefined) throw new Error("Expected an operation declaration");
        return operation;
      }),
    ),
});
