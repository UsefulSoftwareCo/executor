import { Effect, Schema } from "effect";

import { OpenApiParseError } from "../../sdk/errors";
import { type DerivedIdentity, type SpecFormatAdapter } from "../../sdk/spec-format";

import {
  convertGoogleDiscoveryBundleToOpenApi,
  fetchGoogleDiscoveryDocument,
  normalizeGoogleDiscoveryUrl,
} from "./discovery";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseJson = (text: string) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(text).pipe(
    Effect.mapError(
      () =>
        new OpenApiParseError({
          message: "Failed to parse Google Discovery document",
        }),
    ),
  );

const googleDiscoverySlug = (service: string): string =>
  `google_${service
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")}`;

export const deriveGoogleDiscoveryIdentity = (doc: unknown): DerivedIdentity | null => {
  if (!isRecord(doc)) return null;
  const rawName = typeof doc.name === "string" ? doc.name.trim() : "";
  if (!rawName) return null;
  const title = typeof doc.title === "string" && doc.title.trim() ? doc.title.trim() : rawName;
  const description =
    typeof doc.description === "string" && doc.description.trim()
      ? doc.description.trim()
      : undefined;
  return {
    slug: googleDiscoverySlug(rawName),
    name: title,
    ...(description ? { description } : {}),
  };
};

export const googleDiscoveryAdapter: SpecFormatAdapter = {
  id: "google-discovery",
  fetch: (input) =>
    Effect.gen(function* () {
      const documents = yield* Effect.forEach(
        input.urls,
        (url) =>
          fetchGoogleDiscoveryDocument(url, input.credentials).pipe(
            Effect.provide(input.httpClientLayer),
            Effect.map((documentText) => ({
              discoveryUrl: normalizeGoogleDiscoveryUrl(url) ?? url,
              documentText,
            })),
          ),
        { concurrency: 4 },
      );
      const conversion = yield* convertGoogleDiscoveryBundleToOpenApi({ documents });
      const document =
        documents.length === 1
          ? yield* parseJson(documents[0]!.documentText)
          : yield* Effect.forEach(documents, (item) =>
              parseJson(item.documentText).pipe(
                Effect.map((parsed) => ({
                  discoveryUrl: item.discoveryUrl,
                  document: parsed,
                })),
              ),
            );
      return {
        specText: conversion.specText,
        sourceUrl: documents[0]?.discoveryUrl,
        baseUrl: conversion.baseUrl,
        authenticationTemplate: conversion.authenticationTemplate,
        document,
      };
    }),
  deriveIdentity: deriveGoogleDiscoveryIdentity,
};
