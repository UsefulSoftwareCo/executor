import { describe, expect, it } from "@effect/vitest";

import {
  familyMemberEntries,
  presetCatalogItems,
  filterPresetEntries,
  groupPresetEntriesByFamily,
  presetCatalogEntries,
  presetTypeFacets,
  type PresetSourcePlugin,
} from "./preset-catalog";

// A realistic slice of the shipped catalog: OpenAPI carries both standalone
// presets and the two multi-service provider families, MCP repeats some of the
// same vendors under a different protocol, GraphQL contributes one.
const plugins: readonly PresetSourcePlugin[] = [
  {
    key: "openapi",
    label: "OpenAPI",
    presets: [
      { id: "stripe", name: "Stripe", summary: "Payments, subscriptions, and invoices." },
      {
        id: "google-gmail",
        name: "Gmail",
        summary: "Read and send mail.",
        family: "google",
        featured: true,
      },
      { id: "google-drive", name: "Google Drive", summary: "Files and folders.", family: "google" },
      { id: "google-chat", name: "Google Chat", summary: "Spaces and messages.", family: "google" },
      { id: "microsoft-mail", name: "Outlook Mail", summary: "Mail.", family: "microsoft" },
      {
        id: "microsoft-calendar",
        name: "Outlook Calendar",
        summary: "Events.",
        family: "microsoft",
      },
      { id: "microsoft-users", name: "Users", summary: "Directory users.", family: "microsoft" },
    ],
  },
  {
    key: "mcp",
    label: "MCP",
    presets: [
      { id: "linear-mcp", name: "Linear", summary: "Issues and projects.", featured: true },
      { id: "stripe-mcp", name: "Stripe", summary: "Payments over MCP." },
    ],
  },
  {
    key: "graphql",
    label: "GraphQL",
    presets: [{ id: "anilist", name: "AniList", summary: "Anime and manga." }],
  },
];

const entries = presetCatalogEntries(plugins);

const titles = (items: ReturnType<typeof groupPresetEntriesByFamily>): readonly string[] =>
  items.map((item) => (item.type === "family" ? item.label : item.entry.preset.name));

describe("preset catalog", () => {
  it("collapses a multi-service provider into one card and leaves standalone presets alone", () => {
    const items = groupPresetEntriesByFamily(entries);

    // Ten presets, but a browsable six cards: Google and Microsoft each
    // collapse to one, in the position of their first member. (Raw grouping
    // keeps catalog order; `presetCatalogItems` is what re-sorts for display.)
    expect(titles(items)).toEqual(["Stripe", "Google", "Microsoft", "Linear", "Stripe", "AniList"]);

    const google = items.find((item) => item.type === "family" && item.family === "google");
    expect(google?.type === "family" && google.members.length).toBe(3);
  });

  it("only collapses the curated families, not any provider that sets `family`", () => {
    // `MULTI_SERVICE_FAMILIES` is the one rule for "browses as a provider card",
    // shared with the connected-integrations grid. A plugin that tags presets
    // with a family nobody curated lists them as themselves rather than
    // inventing a card the rest of the app won't group behind.
    const uncurated = presetCatalogEntries([
      {
        key: "openapi",
        label: "OpenAPI",
        presets: [
          { id: "acme-billing", name: "Acme Billing", summary: "Invoices.", family: "acme" },
          { id: "acme-crm", name: "Acme CRM", summary: "Contacts.", family: "acme" },
        ],
      },
    ]);

    expect(titles(groupPresetEntriesByFamily(uncurated))).toEqual(["Acme Billing", "Acme CRM"]);
  });

  it("keeps a family with a single service as an ordinary card", () => {
    const solo = presetCatalogEntries([
      {
        key: "openapi",
        label: "OpenAPI",
        presets: [{ id: "google-gmail", name: "Gmail", summary: "Mail.", family: "google" }],
      },
    ]);

    expect(titles(groupPresetEntriesByFamily(solo))).toEqual(["Gmail"]);
  });

  it("searches inside families so buried services surface as themselves", () => {
    // "Outlook Mail" is one of 26 Microsoft services — invisible behind the
    // family card until searched for. Matching siblings must NOT re-collapse
    // into that same card, or the search returns you to where you started.
    expect(titles(presetCatalogItems(entries, { query: "outlook" }))).toEqual([
      "Outlook Mail",
      "Outlook Calendar",
    ]);
  });

  it("floats curated favourites to the front, provider cards included", () => {
    // Linear (MCP) is flagged featured, and Google's services are too, so both
    // lead — otherwise the two providers hiding 6 of the 10 presets sort to
    // wherever their plugin happened to be registered.
    expect(titles(presetCatalogItems(entries, {}))).toEqual([
      "Google",
      "Linear",
      "Stripe",
      "Microsoft",
      "Stripe",
      "AniList",
    ]);
  });

  it("groups providers while browsing and ungroups them while searching", () => {
    expect(titles(presetCatalogItems(entries, { query: "google" }))).toEqual([
      "Gmail",
      "Google Drive",
      "Google Chat",
    ]);
  });

  it("matches the summary and the provider name, not just the preset name", () => {
    expect(titles(presetCatalogItems(entries, { query: "payments" }))).toEqual([
      "Stripe",
      "Stripe",
    ]);

    // Typing the provider name finds its services even though no preset is
    // literally called "Google".
    const google = filterPresetEntries(entries, { query: "google" });
    expect(google.map((entry) => entry.preset.name)).toEqual([
      "Gmail",
      "Google Drive",
      "Google Chat",
    ]);
  });

  it("narrows to one protocol and counts the cards each protocol contributes", () => {
    expect(presetTypeFacets(entries, "")).toEqual([
      { key: null, label: "All", count: 6 },
      { key: "openapi", label: "OpenAPI", count: 3 },
      { key: "mcp", label: "MCP", count: 2 },
      { key: "graphql", label: "GraphQL", count: 1 },
    ]);

    const mcpOnly = filterPresetEntries(entries, { pluginKey: "mcp" });
    expect(mcpOnly.map((entry) => entry.preset.name)).toEqual(["Linear", "Stripe"]);
  });

  it("composes search with the protocol filter and recounts the facets", () => {
    const stripeMcp = filterPresetEntries(entries, { query: "stripe", pluginKey: "mcp" });
    expect(stripeMcp.map((entry) => entry.pluginKey)).toEqual(["mcp"]);

    // Facet counts follow the query so a protocol that can't serve it reads 0.
    expect(presetTypeFacets(entries, "outlook")).toEqual([
      { key: null, label: "All", count: 2 },
      { key: "openapi", label: "OpenAPI", count: 2 },
      { key: "mcp", label: "MCP", count: 0 },
      { key: "graphql", label: "GraphQL", count: 0 },
    ]);
  });

  it("drills into a family and lists only that provider's services", () => {
    expect(familyMemberEntries(entries, "google").map((entry) => entry.preset.name)).toEqual([
      "Gmail",
      "Google Drive",
      "Google Chat",
    ]);
    expect(familyMemberEntries(entries, "nope")).toEqual([]);
  });
});
