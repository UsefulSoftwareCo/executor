import { organizationsAtom } from "@executor-js/hosted-web/contracts/organization";
import type { OrganizationReference } from "@executor-js/hosted-server/organization";
import { hydrated } from "@executor-js/ui/contracts/http";
import { acknowledge } from "@executor-js/ui/contracts/mutations";
import { Effect, Option, Schema } from "effect";
import { Atom, AsyncResult } from "effect/reactivity";
import {
  OnboardingReady,
  OnboardingEntry,
  type CreateTeam,
  SetupGate,
  type SetupSequence,
} from "../../../src/contracts/onboarding.ts";
import { CloudClient } from "./billing.ts";

export const entryTeamAtom = Atom.family((userId: string) =>
  Atom.make<Option.Option<typeof OnboardingEntry.Type>>(Option.none()).pipe(
    Atom.serializable({
      key: `cloud:entry-team:${userId}`,
      schema: Schema.Option(OnboardingEntry),
    }),
    Atom.keepAlive,
  ),
);

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

export const createTeamAtom = Atom.family((userId: string) =>
  CloudClient.runtime
    .fn((details: CreateTeam, get) =>
      Effect.gen(function* () {
        const client = yield* CloudClient;
        const result = yield* client.onboarding.create({ payload: details });
        if (Schema.is(OnboardingReady)(result))
          acknowledge(get, organizationsAtom, () => result.organizations);
        const [team] = result.status === "ready" ? result.organizations : [];
        if (result.status === "ready" && result.setup !== undefined && team !== undefined)
          for (const reference of [team.id, team.slug])
            get.set(createdSetupAtom(reference), Option.some(result.setup));
        get.set(entryTeamAtom(userId), Option.some(result));
        return result;
      }),
    )
    .pipe(Atom.withLabel("ui.onboarding.create")),
);

const createdSetupAtom = Atom.family((_organization: string) =>
  Atom.make<Option.Option<SetupSequence>>(Option.none()).pipe(Atom.keepAlive),
);

export const setupSequenceAtom = Atom.family((organization: OrganizationReference) => {
  const query = CloudClient.query("setup", "sequence", hydrated({ params: { organization } }));
  return Atom.readable(
    (get) => {
      const created = get(createdSetupAtom(organization));
      return Option.isSome(created) ? AsyncResult.success(created.value) : get(query);
    },
    (refresh) => refresh(query),
  ).pipe(Atom.withLabel("ui.onboarding.setup"));
});

const openDashboards = new Set<string>();

export const setupGateRedirect = async (
  read: (path: string) => Promise<Response>,
  organization: string,
): Promise<string | undefined> => {
  if (openDashboards.has(organization)) return undefined;
  const response = await read(
    `/api/organizations/${encodeURIComponent(organization)}/setup/gate`,
  ).catch(() => undefined);
  if (response?.ok !== true) return undefined;
  const gate = Schema.decodeUnknownOption(SetupGate)(await response.json().catch(() => null));
  if (Option.isNone(gate)) return undefined;
  if (gate.value.status === "open") {
    if (typeof window !== "undefined") openDashboards.add(organization);
    return undefined;
  }
  const setup = `/org/${encodeURIComponent(organization)}/setup`;
  if (gate.value.step === "assistant") return `${setup}/assistant`;
  return gate.value.agent === undefined
    ? `${setup}/accounts`
    : `${setup}/accounts?${new URLSearchParams({ assistant: "other", agent: gate.value.agent })}`;
};
