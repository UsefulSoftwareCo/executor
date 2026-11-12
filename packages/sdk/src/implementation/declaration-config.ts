/** Server configuration for the process-wide store of evaluated declarations and tool listings. */
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

/**
 * `EXECUTOR_TOOL_LISTING_FRESH_SECONDS` (default 30) and `EXECUTOR_TOOL_LISTING_MAX_AGE_SECONDS`
 * (default 604800) set how long an evaluated tool listing is reused; a maximum age of 0 evaluates
 * every listing, and a fresh period longer than the maximum age is capped at it.
 * `EXECUTOR_TOOL_LISTING_RENEW_SECONDS` (default 86400) is the age past which search renews the
 * rows it serves in the background; it is capped at the maximum age too.
 * `EXECUTOR_TOOL_LISTING_LOAD_SECONDS` (default 45) stops a listing that has run that long with no
 * request waiting for it; it is capped at the maximum age, past which a listing is never served.
 * `EXECUTOR_EVALUATION_MEMORY_MB` (default 256) bounds the memory of every result this process
 * keeps. See `ToolListingPolicy` for what the window does and does not bound.
 */
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
