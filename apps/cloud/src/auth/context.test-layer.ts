import { Effect, Layer } from "effect";

import { UserStoreService } from "./context";

type UserStore = Parameters<Parameters<UserStoreService["Service"]["use"]>[0]>[0];

export type UserStoreTestState = {
  readonly upsertedOrganizations: Array<{ readonly id: string; readonly name: string }>;
};

export const makeUserStoreTestState = (
  overrides: Partial<UserStoreTestState> = {},
): UserStoreTestState => ({
  upsertedOrganizations: [],
  ...overrides,
});

const testDate = () => new Date("2026-01-01T00:00:00.000Z");

const makeUserStoreTestService = (state: UserStoreTestState): UserStoreService["Service"] => {
  const store = {
    ensureAccount: async (id: string) => ({ id, createdAt: testDate() }),
    getAccount: async (id: string) => ({ id, createdAt: testDate() }),
    upsertOrganization: async (org: { readonly id: string; readonly name: string }) => {
      state.upsertedOrganizations.push(org);
      return { ...org, createdAt: testDate() };
    },
    getOrganization: async (id: string) => ({
      id,
      name: id,
      createdAt: testDate(),
    }),
  } satisfies UserStore;

  return {
    use: (fn) => Effect.promise(() => fn(store)),
  };
};

export const UserStoreTestLayer = (state: UserStoreTestState) =>
  Layer.succeed(UserStoreService)(makeUserStoreTestService(state));
