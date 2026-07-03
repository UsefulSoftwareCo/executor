import { describe, expect, test } from "bun:test";
import {
  getValidRenameTitle,
  isRenameSaveDisabled,
} from "./inbox-sidebar-rename";

describe("getValidRenameTitle", () => {
  test("returns trimmed title for valid updates", () => {
    expect(
      getValidRenameTitle({
        draftTitle: "  New Session Name  ",
        originalTitle: "Old",
      }),
    ).toBe("New Session Name");
  });

  test("returns null when title is empty after trimming", () => {
    expect(
      getValidRenameTitle({ draftTitle: "   ", originalTitle: "Current" }),
    ).toBeNull();
  });

  test("returns null when trimmed draft matches original", () => {
    expect(
      getValidRenameTitle({
        draftTitle: "  Current  ",
        originalTitle: "Current",
      }),
    ).toBeNull();
  });
});

describe("isRenameSaveDisabled", () => {
  test("disables save while rename request is in flight", () => {
    expect(
      isRenameSaveDisabled({
        renaming: true,
        hasTargetSession: true,
        draftTitle: "New title",
        originalTitle: "Current",
      }),
    ).toBe(true);
  });

  test("disables save when there is no target session", () => {
    expect(
      isRenameSaveDisabled({
        renaming: false,
        hasTargetSession: false,
        draftTitle: "New title",
        originalTitle: null,
      }),
    ).toBe(true);
  });

  test("disables save for unchanged or blank titles", () => {
    expect(
      isRenameSaveDisabled({
        renaming: false,
        hasTargetSession: true,
        draftTitle: " Current ",
        originalTitle: "Current",
      }),
    ).toBe(true);

    expect(
      isRenameSaveDisabled({
        renaming: false,
        hasTargetSession: true,
        draftTitle: "   ",
        originalTitle: "Current",
      }),
    ).toBe(true);
  });

  test("enables save when the draft is a valid new title", () => {
    expect(
      isRenameSaveDisabled({
        renaming: false,
        hasTargetSession: true,
        draftTitle: "Updated title",
        originalTitle: "Current",
      }),
    ).toBe(false);
  });
});
