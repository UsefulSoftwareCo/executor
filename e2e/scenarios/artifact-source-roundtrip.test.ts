import { expect } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { composePluginApi } from "@executor-js/api/server";
import { ArtifactId } from "@executor-js/sdk/shared";

import { scenario } from "../src/scenario";
import { Api, Browser, Mcp, Target } from "../src/services";
import { visit } from "../src/surfaces/browser";

const api = composePluginApi([] as const);
const savedArtifact = Schema.Struct({ artifactId: ArtifactId, url: Schema.String });
const sourceResult = Schema.Struct({ code: Schema.String });
const structured = Schema.Struct({ structuredContent: Schema.Unknown });

scenario(
  "Artifacts · text-only clients read current source and edit the same artifact",
  { timeout: 120_000 },
  Effect.gen(function* () {
    const target = yield* Target;
    const mcp = yield* Mcp;
    const browser = yield* Browser;
    const { client: makeClient } = yield* Api;
    const identity = yield* target.newIdentity();
    const client = yield* makeClient(api, identity);
    const session = mcp.session(identity);
    const source = "function App() { return <p>Original source marker</p>; }";
    const created = yield* session.call("create-artifact", {
      title: "Source round trip",
      code: source,
    });
    expect(created.ok).toBe(true);
    const envelope = yield* Schema.decodeUnknownEffect(structured)(created.raw);
    const saved = yield* Schema.decodeUnknownEffect(savedArtifact)(envelope.structuredContent);
    yield* Effect.gen(function* () {
      const shown = yield* session.call("show-artifact", { id: saved.artifactId });
      expect(shown.ok).toBe(true);
      const shownEnvelope = yield* Schema.decodeUnknownEffect(structured)(shown.raw);
      const current = yield* Schema.decodeUnknownEffect(sourceResult)(
        shownEnvelope.structuredContent,
      );
      expect(current.code).toBe(source);
      expect(shown.text).toContain(current.code);
      const updated = current.code.replace("Original source marker", "Updated source marker");
      const edited = yield* session.call("edit-artifact", {
        artifactId: saved.artifactId,
        edits: [{ oldText: current.code, newText: updated }],
      });
      expect(edited.ok, edited.text).toBe(true);
      const afterEdit = yield* session.call("show-artifact", { id: saved.artifactId });
      expect(afterEdit.ok).toBe(true);
      const afterEnvelope = yield* Schema.decodeUnknownEffect(structured)(afterEdit.raw);
      const afterSource = yield* Schema.decodeUnknownEffect(sourceResult)(
        afterEnvelope.structuredContent,
      );
      expect(afterSource.code).toBe(updated);
      expect(afterEdit.text).toContain(updated);
      expect(afterEdit.text).not.toContain("Original source marker");
      yield* browser.session(identity, async ({ page, step }) => {
        await step("Open the artifact edited from its returned source", async () => {
          await visit(page, saved.url);
          await page
            .frameLocator('[data-testid="artifact-shell-frame"]')
            .frameLocator("iframe")
            .getByText("Updated source marker", { exact: true })
            .waitFor({ timeout: 30_000 });
        });
      });
    }).pipe(
      Effect.ensuring(
        client.artifacts.remove({ params: { artifactId: saved.artifactId } }).pipe(
          // oxlint-disable-next-line executor/no-effect-escape-hatch -- boundary: cleanup must fail the scenario if the API cannot remove the fixture
          Effect.orDie,
        ),
      ),
    );
  }),
);
