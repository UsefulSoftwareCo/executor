import { Effect, Schema } from "effect";
import { release } from "../../scripts/releases/config.ts";
import { publishedRelease } from "../../scripts/releases/published.ts";

const published = await Effect.runPromise(publishedRelease);

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

export const releaseCommands = {
  cli: {
    description: `With npm, on Node ${release.minimumNodeVersion} or newer. The package is a launcher that downloads Executor's own runtime for your platform on first run, so Node only starts it. Check that executor --version prints ${published.version} before starting. Supports macOS on Apple Silicon and Intel, Linux (glibc) on ARM64 and x64, and Windows on x64.`,
    command: `${release.npmInstall}\nexecutor --version\nexecutor`,
  },
  "cli-script": {
    description:
      "Without Node, on macOS or Linux: the script checks the download against the release's SHA256SUMS and links ~/.local/bin/executor.",
    command: `curl -fsSL ${release.cloudOrigin}/docs/install.sh | sh`,
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
    command: `git clone --depth 1 --branch '${published.tag}' https://github.com/${release.repository}.git executor-v2\ncd executor-v2\ndocker compose -f apps/hosted/self-host/compose.yaml build --build-arg EXECUTOR_BUILD_VERSION=${published.version}\nEXECUTOR_BUILD_VERSION=${published.version} docker compose -f apps/hosted/self-host/compose.yaml up -d`,
  },
};

export const releaseCommandLanguage = (product: typeof ReleaseCommandProduct.Type) =>
  product === "cli-windows" ? "powershell" : "bash";

export const releaseCommandMarkdown = (product: unknown): string => {
  const name = Schema.decodeUnknownSync(ReleaseCommandProduct)(product);
  const snippet = releaseCommands[name];
  return `${snippet.description}\n\n\`\`\`${releaseCommandLanguage(name)}\n${snippet.command}\n\`\`\``;
};
