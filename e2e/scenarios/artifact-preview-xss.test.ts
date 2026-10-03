import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { AccountHttpApi } from "@executor-js/api";
import { composePluginApi } from "@executor-js/api/server";

import { scenario } from "../src/scenario";
import { Api, Browser, Target } from "../src/services";
import { visit } from "../src/surfaces/browser";

const coreApi = composePluginApi([] as const);

scenario(
  "Artifacts · uploaded previews stay inert after storage and reload",
  { timeout: 120_000 },
  Effect.gen(function* () {
    const target = yield* Target;
    const api = yield* Api;
    const browser = yield* Browser;
    const identity = yield* target.newIdentity();
    const client = yield* api.client(coreApi, identity);
    const account = yield* api.client(AccountHttpApi, identity);
    const me = yield* account.account.me();
    const title = "Preview security check";
    const marker = "Safe preview content";
    const artifact = yield* client.artifacts.save({
      payload: {
        title,
        code: "function App() { return <div>Preview security check</div>; }",
      },
    });

    yield* Effect.gen(function* () {
      const uploaded = yield* client.artifacts.setPreview({
        params: { artifactId: artifact.id },
        payload: {
          preview:
            `<div onclick="document.body.dataset.previewXss='ran'">${marker}` +
            "<script>document.body.dataset.previewXss='ran'</script>" +
            '<img src="/missing-preview-image" onerror="document.body.dataset.previewXss=\'ran\'">' +
            "<iframe srcdoc=\"<script>parent.document.body.dataset.previewXss='ran'</script>\"></iframe>" +
            "<a href=\"javascript:document.body.dataset.previewXss='ran'\">Unsafe link</a></div>",
        },
      });
      expect(uploaded.stored).toBe(true);
      const saved = yield* client.artifacts.get({ params: { artifactId: artifact.id } });
      expect(saved.preview?.markup).toBe(`<div>${marker}Unsafe link</div>`);

      yield* browser.session(identity, async ({ page, step }) => {
        const galleryPath = me.organization?.slug
          ? `/${me.organization.slug}/artifacts`
          : "/artifacts";
        const card = page.locator('[data-slot="artifact-card"]').filter({ hasText: title });
        const preview = card.locator('[data-slot="artifact-preview"]');
        const checkPreview = async () => {
          await preview.getByText(`${marker}Unsafe link`, { exact: true }).waitFor();
          expect(
            await preview.locator("script, img, iframe, a, [onclick], [onerror]").count(),
          ).toBe(0);
          expect(await page.evaluate(() => document.body.dataset.previewXss)).toBeUndefined();
        };
        await step("Open the saved preview with injected markup removed", async () => {
          await visit(page, `${target.baseUrl}${galleryPath}`);
          await checkPreview();
        });
        await step("Reload and verify the stored preview remains inert", async () => {
          await page.reload();
          await checkPreview();
        });
      });
    }).pipe(
      Effect.ensuring(
        client.artifacts.remove({ params: { artifactId: artifact.id } }).pipe(Effect.ignore),
      ),
    );
  }),
);
