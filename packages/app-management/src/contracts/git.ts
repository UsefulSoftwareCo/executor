import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";

// Preserve the existing smart-HTTP path grammar, including the optional .git suffix.
const segment = Schema.String.check(Schema.isPattern(/^[a-z0-9](?:[a-z0-9._-]{0,98}[a-z0-9])?$/i));
const params = { owner: segment, repo: segment };

/** Git transport routes; the repository backend owns binary bodies and product authorization. */
export const AppGitProtocol = HttpApiGroup.make("protocol", { topLevel: true }).add(
  HttpApiEndpoint.get("infoRefs", "/:owner/:repo/info/refs", { params }),
  HttpApiEndpoint.post("uploadPack", "/:owner/:repo/git-upload-pack", { params }),
  HttpApiEndpoint.post("receivePack", "/:owner/:repo/git-receive-pack", { params }),
);
