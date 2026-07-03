import { githubChannel } from "eve/channels/github";

const githubBotName = process.env.GITHUB_APP_SLUG;

export default githubChannel({
  ...(githubBotName ? { botName: githubBotName } : {}),
});
