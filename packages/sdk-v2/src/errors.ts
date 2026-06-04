import { Schema } from "effect";

import { ElicitationDeclinedError } from "./elicitation";
import { ToolAddress } from "./ids";

/* The failure set the SDK surfaces. `StorageError` is the baseline for any
 * storage-touching call; the rest are `execute`'s invoke failures, ported from
 * v1's invoke errors. `address` is the tool address that failed. */

export class StorageError extends Schema.TaggedErrorClass<StorageError>()("StorageError", {
  message: Schema.String,
}) {}

export class ToolNotFoundError extends Schema.TaggedErrorClass<ToolNotFoundError>()(
  "ToolNotFoundError",
  {
    address: ToolAddress,
    suggestions: Schema.optional(Schema.Array(ToolAddress)),
  },
) {}

export class ToolBlockedError extends Schema.TaggedErrorClass<ToolBlockedError>()(
  "ToolBlockedError",
  {
    address: ToolAddress,
    /** The policy pattern that blocked it. */
    pattern: Schema.String,
  },
) {}

export class PluginNotLoadedError extends Schema.TaggedErrorClass<PluginNotLoadedError>()(
  "PluginNotLoadedError",
  {
    address: ToolAddress,
    pluginId: Schema.String,
  },
) {}

export class NoHandlerError extends Schema.TaggedErrorClass<NoHandlerError>()("NoHandlerError", {
  address: ToolAddress,
  pluginId: Schema.String,
}) {}

export class ToolInvocationError extends Schema.TaggedErrorClass<ToolInvocationError>()(
  "ToolInvocationError",
  {
    address: ToolAddress,
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {}

export type ExecuteError =
  | ToolNotFoundError
  | ToolBlockedError
  | PluginNotLoadedError
  | NoHandlerError
  | ToolInvocationError
  | ElicitationDeclinedError
  | StorageError;
