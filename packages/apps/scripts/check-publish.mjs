/** Early releases are deliberately beta-only, including direct npm publish calls. */
import { readFile } from "node:fs/promises";

const manifest = JSON.parse(await readFile(new URL("./package.json", import.meta.url), "utf8"));
const tag = process.env.npm_config_tag ?? manifest.publishConfig?.tag;
if (!/^0\.0\.\d+-beta\.\d+$/.test(manifest.version) || tag !== "beta") {
  throw new Error(
    "Publish apps as 0.0.x-beta.N with --tag beta. Stable releases need an explicit policy change.",
  );
}
