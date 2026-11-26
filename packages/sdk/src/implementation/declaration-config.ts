import { Config, Schema } from "effect";
import {
  defaultToolListingPolicy,
  processDeclarationLimits,
  type DeclarationLimits,
  type ToolListingPolicy,
} from "../contracts/declarations.ts";

const nonNegative = (name: string, fallback: number) =>
  Config.schema(FiniteNonNegative, name).pipe(Config.withDefault(fallback));
const FiniteNonNegative = Schema.FiniteFromString.check(Schema.isGreaterThanOrEqualTo(0));

export const declarationConfig: Config.Config<{
  readonly limits: DeclarationLimits;
  readonly toolListings: ToolListingPolicy;
}> = Config.all({
  fresh: nonNegative(
    "EXECUTOR_TOOL_LISTING_FRESH_SECONDS",
    defaultToolListingPolicy.freshMillis / 1_000,
  ),
  renew: nonNegative(
    "EXECUTOR_TOOL_LISTING_RENEW_SECONDS",
    defaultToolListingPolicy.renewMillis / 1_000,
  ),
  maxAge: nonNegative(
    "EXECUTOR_TOOL_LISTING_MAX_AGE_SECONDS",
    defaultToolListingPolicy.maxStaleMillis / 1_000,
  ),
  load: nonNegative(
    "EXECUTOR_TOOL_LISTING_LOAD_SECONDS",
    defaultToolListingPolicy.loadMillis / 1_000,
  ),
  memory: nonNegative("EXECUTOR_EVALUATION_MEMORY_MB", processDeclarationLimits.bytes / 2 ** 20),
}).pipe(
  Config.map(({ fresh, renew, maxAge, load, memory }) => {
    const bytes = Math.round(memory * 2 ** 20);
    return {
      limits: {
        entries: processDeclarationLimits.entries,
        bytes,
        entryBytes: Math.min(processDeclarationLimits.entryBytes, bytes),
        renewals: processDeclarationLimits.renewals,
      },
      toolListings: {
        ...defaultToolListingPolicy,
        freshMillis: Math.round(Math.min(fresh, maxAge) * 1_000),
        renewMillis: Math.round(Math.min(renew, maxAge) * 1_000),
        maxStaleMillis: Math.round(maxAge * 1_000),
        loadMillis: Math.round(Math.min(load, maxAge) * 1_000),
      },
    };
  }),
);
