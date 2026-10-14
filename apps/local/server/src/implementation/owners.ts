/**
 * Local assigns every owner itself; a caller's owner never creates a new one. Apps, OAuth clients
 * and connected accounts belong to `local`, except the host's bundled Executor app and its API key
 * account, which belong to `executor-local`. A connected account takes its app's owner.
 */
import { OwnerId } from "@executor-js/sdk/core";

/** The local user's apps, OAuth clients and accounts. */
export const localOwner = OwnerId.make("local");
/** The host's bundled Executor app and its API key account. */
export const executorAppOwner = OwnerId.make("executor-local");
/** Every owner local assigns, so every owner its accounts can have. */
export const localOwners = [localOwner, executorAppOwner] as const;
