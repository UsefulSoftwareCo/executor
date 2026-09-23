import { organizationsAtom } from "@executor-js/hosted-web/contracts/organization";
import { acknowledge } from "@executor-js/ui/contracts/mutations";
import { Effect, Option, Schema } from "effect";
import { Atom, AsyncResult } from "effect/unstable/reactivity";
import {
  OnboardingReady,
  type OnboardingEntry,
  type CreateTeam,
} from "../../../src/contracts/onboarding.ts";
import { CloudClient } from "./billing.ts";

/** Initial setup metadata comes from the private sign-in document, not a second browser request. */
export const entryTeamAtom = Atom.family((_userId: string) =>
  Atom.make<Option.Option<typeof OnboardingEntry.Type>>(Option.none()).pipe(Atom.keepAlive),
);

/** Explicit refresh discards document data and reads current membership, invitations and suggestions. */
export const prepareTeamAtom = Atom.family((userId: string) => {
  const query = CloudClient.runtime.atom((get) =>
    Effect.gen(function* () {
      const client = yield* CloudClient;
      const entry = yield* client.onboarding.prepare({});
      if (Schema.is(OnboardingReady)(entry))
        acknowledge(get, organizationsAtom, () => entry.organizations);
      return entry;
    }),
  );
  return Atom.readable(
    (get) => {
      const entry = get(entryTeamAtom(userId));
      return Option.isSome(entry) ? AsyncResult.success(entry.value) : get(query);
    },
    (refresh) => {
      refresh(entryTeamAtom(userId));
      refresh(query);
    },
  ).pipe(Atom.withLabel("ui.onboarding.prepare"));
});

/** Only confirmation creates a team; publish its identity before the router changes pages. */
export const createTeamAtom = Atom.family((userId: string) =>
  CloudClient.runtime
    .fn((details: CreateTeam, get) =>
      Effect.gen(function* () {
        const client = yield* CloudClient;
        const result = yield* client.onboarding.create({ payload: details });
        if (Schema.is(OnboardingReady)(result))
          acknowledge(get, organizationsAtom, () => result.organizations);
        get.set(entryTeamAtom(userId), Option.some(result));
        return result;
      }),
    )
    .pipe(Atom.withLabel("ui.onboarding.create")),
);
