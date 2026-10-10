export const ONBOARDING_PRACTICE_STEPS = [
  "build_app",
  "create_workflow",
  "create_skill",
  "store_notes",
] as const;

export type OnboardingPracticeStep = (typeof ONBOARDING_PRACTICE_STEPS)[number];

type OnboardingStorage = Pick<Storage, "getItem" | "setItem">;

const storageKey = (organizationSlug: string | null): string =>
  `executor.onboarding.progress.v1.${organizationSlug ?? "local"}`;

const ProgressSchema = Schema.Array(Schema.Literals(ONBOARDING_PRACTICE_STEPS));
const decodeProgress = Schema.decodeUnknownOption(Schema.fromJsonString(ProgressSchema));

export const readOnboardingPracticeProgress = (
  storage: OnboardingStorage | null | undefined,
  organizationSlug: string | null,
): ReadonlySet<OnboardingPracticeStep> => {
  if (!storage) return new Set();
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: browser storage can throw when disabled
  try {
    const raw = storage.getItem(storageKey(organizationSlug));
    return raw
      ? new Set(Option.getOrElse(decodeProgress(raw), () => [] as OnboardingPracticeStep[]))
      : new Set();
  } catch {
    return new Set();
  }
};

export const writeOnboardingPracticeProgress = (
  storage: OnboardingStorage | null | undefined,
  organizationSlug: string | null,
  progress: ReadonlySet<OnboardingPracticeStep>,
): void => {
  if (!storage) return;
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: browser storage can throw when disabled
  try {
    storage.setItem(storageKey(organizationSlug), JSON.stringify([...progress]));
  } catch {
    // Storage is optional. The visible state remains useful for this session.
  }
};
import { Option, Schema } from "effect";
