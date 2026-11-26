import { createId } from "@paralleldrive/cuid2";
import { Effect } from "effect";

export const generateId: Effect.Effect<string> = Effect.sync(() => createId());

export const generateUuid: Effect.Effect<string> = Effect.sync(() => crypto.randomUUID());
