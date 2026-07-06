import { describe, expect, it } from "@effect/vitest";
import { IntegrationSlug } from "@executor-js/sdk/shared";
import * as Exit from "effect/Exit";
import * as React from "react";
import type { ReactElement, ReactNode } from "react";

import {
  GoogleServiceResultPanel,
  googleAddServicesPayload,
  submitGoogleServicesSelection,
  type AddGoogleServicesMutation,
} from "./AddGoogleSource";
import type { GoogleAddServicesResult } from "../sdk/plugin";

type TestElementProps = {
  readonly children?: ReactNode;
  readonly onClick?: (event?: unknown) => void;
};

const collectText = (node: ReactNode): string => {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(collectText).join(" ");
  if (React.isValidElement<TestElementProps>(node)) return collectText(node.props.children);
  return "";
};

const findElementWithText = (
  node: ReactNode,
  text: string,
): ReactElement<TestElementProps> | null => {
  if (node === null || node === undefined || typeof node === "boolean") return null;
  if (typeof node === "string" || typeof node === "number") return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElementWithText(child, text);
      if (found) return found;
    }
    return null;
  }
  if (!React.isValidElement<TestElementProps>(node)) return null;
  if (collectText(node.props.children).trim() === text) return node;
  return findElementWithText(node.props.children, text);
};

const emptyResult: GoogleAddServicesResult = {
  added: [],
  skipped: [],
  failed: [],
};

describe("AddGoogleSource per-service submit", () => {
  it("submits three checked presets in one addServices call", async () => {
    const calls: Parameters<AddGoogleServicesMutation>[0][] = [];
    const addServices: AddGoogleServicesMutation = (input) => {
      calls.push(input);
      return Promise.resolve(Exit.succeed(emptyResult));
    };

    await submitGoogleServicesSelection(addServices, {
      presetIds: ["google-calendar", "google-gmail", "google-drive"],
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.payload).toEqual({
      services: [
        { presetId: "google-calendar" },
        { presetId: "google-gmail" },
        { presetId: "google-drive" },
      ],
    });
  });

  it("renders added, skipped, and failed result rows", () => {
    const result: GoogleAddServicesResult = {
      added: [
        {
          slug: IntegrationSlug.make("google_calendar"),
          presetId: "google-calendar",
          toolCount: 12,
        },
      ],
      skipped: [
        {
          slug: IntegrationSlug.make("google_gmail"),
          presetId: "google-gmail",
          reason: "already_exists",
        },
      ],
      failed: [
        {
          slug: IntegrationSlug.make("google_drive"),
          presetId: "google-drive",
          error: "Discovery fetch failed",
        },
        {
          slug: IntegrationSlug.make("google_custom"),
          presetId: "custom",
          error: "Custom Discovery fetch failed",
        },
      ],
    };

    const text = collectText(
      GoogleServiceResultPanel({
        result,
        retryingPresetId: null,
        onRetry: () => {},
      }),
    );

    expect(text).toContain("Google Calendar");
    expect(text).toContain("Added");
    expect(text).toContain("Gmail");
    expect(text).toContain("Already exists");
    expect(text).toContain("Google Drive");
    expect(text).toContain("Discovery fetch failed");
    expect(text).toContain("Custom Discovery URLs");
    expect(text).toContain("Custom Discovery fetch failed");
    expect(text).toContain("Retry");
  });

  it("retry re-submits only the failed presetId", async () => {
    let retryPresetId: string | null = null;
    const result: GoogleAddServicesResult = {
      added: [],
      skipped: [],
      failed: [
        {
          slug: IntegrationSlug.make("google_drive"),
          presetId: "google-drive",
          error: "Discovery fetch failed",
        },
      ],
    };
    const retry = findElementWithText(
      GoogleServiceResultPanel({
        result,
        retryingPresetId: null,
        onRetry: (presetId: string) => {
          retryPresetId = presetId;
        },
      }),
      "Retry",
    );

    retry?.props.onClick?.();

    const calls: Parameters<AddGoogleServicesMutation>[0][] = [];
    const addServices: AddGoogleServicesMutation = (input) => {
      calls.push(input);
      return Promise.resolve(Exit.succeed(emptyResult));
    };
    await submitGoogleServicesSelection(addServices, {
      presetIds: retryPresetId ? [retryPresetId] : [],
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.payload).toEqual({
      services: [{ presetId: "google-drive" }],
    });
  });

  it("passes name and slug overrides for a single selected service", () => {
    expect(
      googleAddServicesPayload({
        presetIds: ["google-calendar"],
        identityOverride: {
          slug: "team_calendar",
          name: "Team Calendar",
        },
      }),
    ).toEqual({
      services: [
        {
          presetId: "google-calendar",
          slug: "team_calendar",
          name: "Team Calendar",
        },
      ],
    });
  });

  it("submits custom Discovery URLs as one service entry", () => {
    expect(
      googleAddServicesPayload({
        presetIds: ["google-calendar"],
        custom: {
          urls: ["https://www.googleapis.com/discovery/v1/apis/tasks/v1/rest"],
          slug: "google_custom",
          name: "Custom Google APIs",
          description: "Custom Google APIs.",
        },
        baseUrl: " https://proxy.example ",
      }),
    ).toEqual({
      services: [
        { presetId: "google-calendar" },
        {
          custom: {
            urls: ["https://www.googleapis.com/discovery/v1/apis/tasks/v1/rest"],
            slug: "google_custom",
            name: "Custom Google APIs",
            description: "Custom Google APIs.",
          },
        },
      ],
      baseUrl: "https://proxy.example",
    });
  });
});
