import { describe, expect, it } from "@effect/vitest";

import {
  readOnboardingPracticeProgress,
  writeOnboardingPracticeProgress,
} from "./onboarding-progress";

const makeStorage = () => {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    values,
  };
};

describe("onboarding practice progress", () => {
  it("persists recognized steps per organization", () => {
    const storage = makeStorage();
    writeOnboardingPracticeProgress(storage, "acme", new Set(["build_app", "store_notes"]));

    expect([...readOnboardingPracticeProgress(storage, "acme")]).toEqual([
      "build_app",
      "store_notes",
    ]);
    expect([...readOnboardingPracticeProgress(storage, "other")]).toEqual([]);
  });

  it("ignores malformed or unknown stored values", () => {
    const storage = makeStorage();
    storage.values.set("executor.onboarding.progress.v1.acme", '["build_app", "unknown", 2]');

    expect([...readOnboardingPracticeProgress(storage, "acme")]).toEqual([]);
  });
});
