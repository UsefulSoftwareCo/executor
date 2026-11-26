import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";

const segment = Schema.String.check(
  Schema.isPattern(/^[a-zA-Z0-9](?:[a-zA-Z0-9._-]{0,98}[a-zA-Z0-9])?$/u),
);
const params = { owner: segment, repo: segment };

export const AppGitProtocol = HttpApiGroup.make("protocol", { topLevel: true }).add(
  HttpApiEndpoint.get("infoRefs", "/:owner/:repo/info/refs", { params }),
  HttpApiEndpoint.post("uploadPack", "/:owner/:repo/git-upload-pack", { params }),
  HttpApiEndpoint.post("receivePack", "/:owner/:repo/git-receive-pack", { params }),
);
