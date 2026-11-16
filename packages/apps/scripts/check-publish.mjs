/** Beta-only releases. Fork builds require an explicit, matching private registry. */
import { readFile } from "node:fs/promises";

// --package lets the reviewed policy check a historical compiled package without rewriting it.
const directory = process.argv[2] === "--package" ? process.argv[3] : undefined;
const manifest = JSON.parse(
  await readFile(
    directory ? `${directory}/package.json` : new URL("./package.json", import.meta.url),
    "utf8",
  ),
);
const tag = process.env.npm_config_tag ?? manifest.publishConfig?.tag;
const fork = /^0\.0\.\d+-beta\.\d+\.shuv\.\d+$/.test(manifest.version);
if ((!/^0\.0\.\d+-beta\.\d+$/.test(manifest.version) && !fork) || tag !== "beta") {
  throw new Error(
    "Publish apps as 0.0.x-beta.N (or a private 0.0.x-beta.N.shuv.M) with --tag beta. Stable releases need an explicit policy change.",
  );
}

if (fork) {
  const normalize = (value) => {
    const url = new URL(value);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      /(^|\.)npmjs\.(org|com)\.?$/.test(url.hostname)
    )
      throw new Error("Fork apps releases must never be published to public npm.");
    return url.href.replace(/\/+$/, "");
  };
  const configured = process.env.EXECUTOR_NPM_REGISTRY;
  const destination = process.env.npm_config_registry;
  if (
    !configured ||
    !destination ||
    normalize(configured) !== normalize(destination) ||
    (manifest.publishConfig?.registry &&
      normalize(configured) !== normalize(manifest.publishConfig.registry))
  ) {
    throw new Error(
      "Fork apps releases require EXECUTOR_NPM_REGISTRY and --registry to name the same private registry.",
    );
  }
}
