import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";

import {
  buildToolTypeScriptPreview,
  schemaToTypeScriptPreview,
  schemaToTypeScriptPreviewWithDefs,
} from "./schema-types";

const StripeBalanceTransactionsFixture = Schema.Struct({
  schema: Schema.Unknown,
  defs: Schema.Record(Schema.String, Schema.Unknown),
});

const stripeBalanceTransactionsFixture = Schema.decodeUnknownSync(
  Schema.fromJsonString(StripeBalanceTransactionsFixture),
)(
  readFileSync(
    new URL("./__fixtures__/stripe-get-balance-transactions-id.json", import.meta.url),
    "utf8",
  ),
);

const sdkPackageRoot = fileURLToPath(new URL("..", import.meta.url));

describe("schema-types", () => {
  it("reuses referenced definitions instead of inlining them", async () => {
    const schema = {
      type: "object",
      properties: {
        homeAddress: { $ref: "#/$defs/Address" },
        workAddress: { $ref: "#/$defs/Address" },
      },
      required: ["homeAddress", "workAddress"],
      additionalProperties: false,
      $defs: {
        Address: {
          type: "object",
          properties: {
            street: { type: "string" },
            city: { type: "string" },
            zip: { type: "string" },
          },
          required: ["street", "city", "zip"],
          additionalProperties: false,
        },
      },
    };

    expect(await schemaToTypeScriptPreview(schema)).toEqual({
      type: "{ homeAddress: Address; workAddress: Address; }",
      definitions: {
        Address: "{ street: string; city: string; zip: string; }",
      },
    });
  });

  it("can render against shared definitions provided externally", async () => {
    const schema = {
      type: "object",
      properties: {
        headquarters: { $ref: "#/$defs/Address" },
      },
      required: ["headquarters"],
      additionalProperties: false,
    };

    const defs = new Map<string, unknown>([
      [
        "Address",
        {
          type: "object",
          properties: {
            city: { type: "string" },
          },
          required: ["city"],
          additionalProperties: false,
        },
      ],
    ]);

    expect(await schemaToTypeScriptPreviewWithDefs(schema, defs)).toEqual({
      type: "{ headquarters: Address; }",
      definitions: {
        Address: "{ city: string; }",
      },
    });
  });

  it("renders transitive referenced definitions", async () => {
    const defs = new Map<string, unknown>([
      [
        "LevelOne",
        {
          type: "object",
          properties: {
            next: { $ref: "#/$defs/LevelTwo" },
          },
          required: ["next"],
          additionalProperties: false,
        },
      ],
      [
        "LevelTwo",
        {
          type: "object",
          properties: {
            next: { $ref: "#/$defs/LevelThree" },
          },
          required: ["next"],
          additionalProperties: false,
        },
      ],
      [
        "LevelThree",
        {
          type: "object",
          properties: {
            next: { $ref: "#/$defs/LevelFour" },
          },
          required: ["next"],
          additionalProperties: false,
        },
      ],
      [
        "LevelFour",
        {
          type: "object",
          properties: {
            value: { type: "string" },
          },
          required: ["value"],
          additionalProperties: false,
        },
      ],
    ]);

    expect(
      await schemaToTypeScriptPreviewWithDefs(
        {
          $ref: "#/$defs/LevelOne",
        },
        defs,
      ),
    ).toEqual({
      type: "LevelOne",
      definitions: {
        LevelFour: "{ value: string; }",
        LevelOne: "{ next: LevelTwo; }",
        LevelThree: "{ next: LevelFour; }",
        LevelTwo: "{ next: LevelThree; }",
      },
    });
  });

  it("keeps ordinary unions expanded", async () => {
    const defs = new Map<string, unknown>([
      [
        "Pet",
        {
          anyOf: [{ $ref: "#/$defs/Dog" }, { $ref: "#/$defs/Cat" }, { $ref: "#/$defs/Lizard" }],
        },
      ],
      [
        "Dog",
        {
          type: "object",
          properties: {
            bark: { type: "boolean" },
          },
          required: ["bark"],
          additionalProperties: false,
        },
      ],
      [
        "Cat",
        {
          type: "object",
          properties: {
            meow: { type: "boolean" },
          },
          required: ["meow"],
          additionalProperties: false,
        },
      ],
      [
        "Lizard",
        {
          type: "object",
          properties: {
            scales: { type: "boolean" },
          },
          required: ["scales"],
          additionalProperties: false,
        },
      ],
    ]);

    expect(
      await schemaToTypeScriptPreviewWithDefs(
        {
          $ref: "#/$defs/Pet",
        },
        defs,
      ),
    ).toEqual({
      type: "Pet",
      definitions: {
        Cat: "{ meow: boolean; }",
        Dog: "{ bark: boolean; }",
        Lizard: "{ scales: boolean; }",
        Pet: "Dog | Cat | Lizard",
      },
    });
  });

  it("renders large unions from real Stripe fixtures", async () => {
    const defs = new Map(Object.entries(stripeBalanceTransactionsFixture.defs));

    const preview = await schemaToTypeScriptPreviewWithDefs(
      stripeBalanceTransactionsFixture.schema,
      defs,
    );

    expect(preview.type).toBe("BalanceTransaction");
    expect(preview.definitions.BalanceTransaction).toContain("fee_details: Fee[]");
    expect(preview.definitions.BalanceTransaction).toContain("source: string | Polymorphic | null");
    expect(preview.definitions.Fee).toBe(
      "{ amount: number; application: string | null; currency: string; description: string | null; type: string; }",
    );
    expect(preview.definitions.Polymorphic).toContain("Charge");
    expect(preview.definitions.Polymorphic).toContain("Refund");
    expect(preview.definitions.Polymorphic).toContain("Payout");
    expect(preview.definitions.Polymorphic).not.toContain("unknown");
    expect(Object.keys(preview.definitions).length).toBeGreaterThan(100);
  });

  it("sanitizes dashed definition names and quotes dashed property keys", async () => {
    const preview = await schemaToTypeScriptPreview({
      type: "object",
      properties: {
        "dash-prop": { type: ["string", "null"] },
        child: { $ref: "#/$defs/foo-bar" },
      },
      required: ["dash-prop", "child"],
      additionalProperties: false,
      $defs: {
        "foo-bar": {
          type: "object",
          properties: {
            id: { type: "string" },
          },
          required: ["id"],
          additionalProperties: false,
        },
      },
    });

    expect(preview).toEqual({
      type: '{ "dash-prop": string | null; child: FooBar; }',
      definitions: {
        FooBar: "{ id: string; }",
      },
    });
    expect(preview.definitions).not.toHaveProperty("foo-bar");
  });

  it("normalizes OpenAPI nullable schemas before compiling", async () => {
    const preview = await schemaToTypeScriptPreview({
      type: "object",
      properties: {
        maybeObject: {
          type: "object",
          nullable: true,
          properties: {
            id: { type: "string" },
          },
          required: ["id"],
          additionalProperties: false,
        },
        maybeEnum: {
          enum: ["created", "updated"],
          nullable: true,
        },
        maybeConst: {
          const: "ok",
          nullable: true,
        },
      },
      required: ["maybeObject", "maybeEnum", "maybeConst"],
      additionalProperties: false,
    });

    expect(preview.type).toBe(
      '{ maybeObject: { id: string; } | null; maybeEnum: "created" | "updated" | null; maybeConst: "ok" | null; }',
    );
  });

  it("handles recursive refs through the compiler wrapper", async () => {
    const preview = await schemaToTypeScriptPreview({
      $ref: "#/$defs/IssueFilter",
      $defs: {
        IssueFilter: {
          type: "object",
          properties: {
            and: {
              type: "array",
              items: { $ref: "#/$defs/IssueFilter" },
            },
          },
          additionalProperties: false,
        },
      },
    });

    expect(preview).toEqual({
      type: "IssueFilter",
      definitions: {
        IssueFilter: "{ and?: IssueFilter[]; }",
      },
    });
  });

  it("merges input and output TypeScript definitions", async () => {
    const defs = new Map<string, unknown>([
      [
        "Address",
        {
          type: "object",
          properties: {
            city: { type: "string" },
          },
          required: ["city"],
          additionalProperties: false,
        },
      ],
      [
        "Contact",
        {
          type: "object",
          properties: {
            id: { type: "string" },
            address: { $ref: "#/$defs/Address" },
          },
          required: ["id", "address"],
          additionalProperties: false,
        },
      ],
    ]);

    expect(
      await buildToolTypeScriptPreview({
        inputSchema: {
          type: "object",
          properties: {
            address: { $ref: "#/$defs/Address" },
          },
          required: ["address"],
          additionalProperties: false,
        },
        outputSchema: {
          $ref: "#/$defs/Contact",
        },
        defs,
      }),
    ).toEqual({
      inputTypeScript: "{ address: Address; }",
      outputTypeScript: "Contact",
      typeScriptDefinitions: {
        Address: "{ city: string; }",
        Contact: "{ id: string; address: Address; }",
      },
    });
  });

  it("loads the vendored compiler through Bun's TypeScript loader", () => {
    const output = execFileSync(
      "bun",
      [
        "-e",
        `
          import { buildToolTypeScriptPreview } from "./src/schema-types.ts";
          const preview = await buildToolTypeScriptPreview({
            inputSchema: {
              type: "object",
              properties: {
                account_id: { type: "string" },
                body: {}
              },
              required: ["account_id", "body"],
              additionalProperties: false
            },
            outputSchema: {},
            defs: new Map()
          });
          console.log(JSON.stringify(preview));
        `,
      ],
      { cwd: sdkPackageRoot, encoding: "utf8" },
    );

    expect(JSON.parse(output)).toEqual({
      inputTypeScript: "{ account_id: string; body: unknown; }",
      outputTypeScript: "unknown",
    });
  });
});
