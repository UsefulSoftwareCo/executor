import { sessionInitialValues } from "@executor-js/hosted-web/contracts/auth";
import { entryOrganizationsAtom } from "@executor-js/hosted-web/contracts/organization";
import { writeSessionHint } from "@executor-js/hosted-web/session-hint";
import { Atom } from "effect/unstable/reactivity";
import { Schema, Option } from "effect";
import { CloudEntryPage } from "../../../src/contracts/entry.ts";
import { OnboardingReady } from "../../../src/contracts/onboarding.ts";
import { entryTeamAtom } from "../contracts/onboarding.ts";

/** Consume private document data before routing or rendering; API authorization remains live. */
export const cloudEntryInitialValues = () => {
  const element = document.getElementById("executor-entry");
  if (element === null) return sessionInitialValues();
  const parsed = Schema.decodeUnknownOption(Schema.fromJsonString(CloudEntryPage))(
    element.textContent,
  );
  element.remove();
  if (Option.isNone(parsed)) throw new Error("Invalid entry document");
  const entry = parsed.value;
  if (window.location.pathname !== entry.path)
    window.history.replaceState(window.history.state, "", entry.path);
  writeSessionHint(entry.session);
  if (entry.session === null || entry.onboarding === null)
    return sessionInitialValues(entry.session);
  return [
    ...sessionInitialValues(entry.session),
    Atom.initialValue(
      entryOrganizationsAtom,
      Option.some(
        Schema.is(OnboardingReady)(entry.onboarding) ? entry.onboarding.organizations : [],
      ),
    ),
    Atom.initialValue(entryTeamAtom(entry.session.user.id), Option.some(entry.onboarding)),
  ];
};
