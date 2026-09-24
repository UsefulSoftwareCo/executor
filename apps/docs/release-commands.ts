import { Schema } from "effect";
import { release } from "../../scripts/releases/config.ts";

/** Release snippets shared by the browser docs and Blume's Markdown output. */
export const ReleaseCommandProduct = Schema.Literals([
  "cli",
  "docker",
  "docker-channel",
  "docker-image",
  "source",
]);

/** Concrete instructions generated from the same identity as the published artifacts. */
export const releaseCommands = {
  cli: {
    description: `Requires Node 24.14 or newer. Version ${release.version} supports macOS on Apple Silicon and Intel, Linux on ARM64 and x64, and Windows on x64.`,
    command: `${release.npmInstall}\nexecutor`,
  },
  docker: {
    description: `Use version ${release.version} on Linux AMD64 or ARM64:`,
    command: `docker pull ${release.image}:${release.imageTag}\ndocker run -d --name executor-v2 --restart unless-stopped \\
  -p 127.0.0.1:4400:4400 -v executor-v2-data:/app/data \\
  ${release.image}:${release.imageTag}`,
  },
  "docker-channel": {
    description: `To follow the ${release.channel} channel, use this image tag in the run command. Pull it again before recreating the container to update. Back up the volume before upgrading.`,
    command: `docker pull ${release.image}:${release.channel}`,
  },
  "docker-image": {
    description: "Create a Railway service from this image:",
    command: `${release.image}:${release.imageTag}`,
  },
  source: {
    description: "The public repository includes a Compose setup that builds this release locally:",
    command: `git clone --depth 1 --branch '${release.tag}' https://github.com/${release.repository}.git executor-v2\ncd executor-v2\ndocker compose -f apps/hosted/self-host/compose.yaml build --build-arg EXECUTOR_BUILD_VERSION=${release.version}\ndocker compose -f apps/hosted/self-host/compose.yaml up -d`,
  },
};

/** Render a parsed docs component as plain Markdown for agents and raw-page downloads. */
export const releaseCommandMarkdown = (product: unknown): string => {
  const snippet = releaseCommands[Schema.decodeUnknownSync(ReleaseCommandProduct)(product)];
  return `${snippet.description}\n\n\`\`\`bash\n${snippet.command}\n\`\`\``;
};
