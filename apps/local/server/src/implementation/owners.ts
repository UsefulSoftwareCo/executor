import { OwnerId } from "@executor-js/sdk/core";

export const localOwner = OwnerId.make("local");
export const executorAppOwner = OwnerId.make("executor-local");
export const localOwners = [localOwner, executorAppOwner] as const;
