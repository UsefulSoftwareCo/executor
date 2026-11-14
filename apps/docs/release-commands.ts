import { Effect, Schema } from "effect";
import { release } from "../../scripts/releases/config.ts";
import { publishedRelease } from "../../scripts/releases/published.ts";

/**
 * Snippets name the newest published release, not this checkout's version: a merged version bump
 * precedes its publication, and its image and Git tag do not exist until then. Building the docs
 * fails when npm cannot be read, rather than naming a version that may not exist.
 */
const published = await Effect.runPromise(publishedRelease);

/** Release snippets shared by the browser docs and Blume's Markdown output. */
export const ReleaseCommandProduct = Schema.Literals([
  "cli",
  "cli-script",
  "cli-windows",
  "cli-homebrew",
  "docker",
  "docker-channel",
  "docker-image",
  "source",
]);

/** Concrete instructions generated from the same identity as the published artifacts. */
export const releaseCommands = {
  cli: {
    description: `With npm, on Node ${release.minimumNodeVersion} or newer. The package is a launcher that downloads Executor's own runtime for your platform on first run, so Node only starts it. Check that executor --version prints ${published.version} before starting. Supports macOS on Apple Silicon and Intel, Linux (glibc) on ARM64 and x64, and Windows on x64.`,
    command: `${release.npmInstall}\nexecutor --version\nexecutor`,
  },
  "cli-script": {
    description:
      "Without Node, on macOS or Linux: the script checks the download against the release's SHA256SUMS and links ~/.local/bin/executor.",
    command: `curl -fsSL ${release.cloudOrigin}/docs/install.sh | sh\nexecutor --version\nexecutor`,
  },
  "cli-windows": {
    description: "Without Node, on Windows, in PowerShell:",
    command: `irm ${release.cloudOrigin}/docs/install.ps1 | iex`,
  },
  "cli-homebrew": {
    description: "With Homebrew, on macOS or Linux:",
    command: `brew install usefulsoftwareco/tap/${release.channel === "beta" ? "executor-beta" : "executor"}`,
  },
  docker: {
    description: `Use version ${published.version} on Linux AMD64 or ARM64:`,
    command: `docker pull ${release.image}:${published.imageTag}\ndocker run -d --name executor-v2 --init --restart unless-stopped \\
  -p 127.0.0.1:4400:4400 -v executor-v2-data:/app/data \\
  ${release.image}:${published.imageTag}`,
  },
  "docker-channel": {
    description: `To follow the ${release.channel} channel, use this image tag in the run command. Pull it again before recreating the container to update. Back up the volume before upgrading.`,
    command: `docker pull ${release.image}:${release.channel}`,
  },
  "docker-image": {
    description: "Create a Railway service from this image:",
    command: `${release.image}:${published.imageTag}`,
  },
  source: {
    description: "The public repository includes a Compose setup that builds this release locally:",
    command: `git clone --depth 1 --branch '${published.tag}' https://github.com/${release.repository}.git executor-v2\ncd executor-v2\ndocker compose -f apps/hosted/self-host/compose.yaml build --build-arg EXECUTOR_BUILD_VERSION=${published.version}\ndocker compose -f apps/hosted/self-host/compose.yaml up -d`,
  },
};

/** Render a parsed docs component as plain Markdown for agents and raw-page downloads. */
export const releaseCommandMarkdown = (product: unknown): string => {
  const snippet = releaseCommands[Schema.decodeUnknownSync(ReleaseCommandProduct)(product)];
  return `${snippet.description}\n\n\`\`\`bash\n${snippet.command}\n\`\`\``;
};
