import { Option, Schema } from "effect";
import { CacheCommand } from "./contracts/cache.ts";

export const discardsEvaluated = (command: unknown) => {
  const operation = Schema.decodeUnknownOption(CacheCommand)(command);
  if (Option.isNone(operation)) return false;
  const value = operation.value;
  return value.operation === "invalidate" || (value.operation === "acquire" && value.refresh);
};
