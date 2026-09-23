# Marketing site

The existing Executor marketing site, copied from the previous product. Astro
prerenders the pages; React islands keep the existing demos and interactions.
The dashboard remains a separate React SPA.

From the repository root:

- `bun run marketing:build` builds the static site.
- `bun run hosted:cloud:site:build` builds marketing and the cloud dashboard,
  then assembles the Alchemy asset directory.
- `bun run --cwd apps/marketing dev` runs Astro alone for marketing development.
  Product and sign-in links need the combined cloud origin.

The cloud Site resource supplies `EXECUTOR_SITE_ORIGIN` from its canonical origin.
Marketing prompts, Markdown endpoints, `llms.txt`, and docs metadata use that value.
Standalone builds default to `https://v2.executor.sh`; malformed overrides fail the build.
Cloud dashboard docs links stay on the current origin. Local and self-host dashboards
use the public v2 docs because they do not serve the cloud documentation assets.

Cloud development at `https://127.0.0.1:5395` serves the static marketing build
beside the dashboard's Vite server. Rebuild marketing after edits and reload the
page; dashboard hot reload is unchanged.

The public homepage is `/`. A session cookie redirects it to `/app`; that is
only a routing hint, and the product still checks the real session. `/home`
always shows the public site. Login is `/login`. Other marketing pages remain
public even when signed in. No marketing request needs an auth database query.

The `cookie` dependency is explicit because Astro's prerender output imports
its v2 ESM API. Resolving the older workspace cookie package breaks the build.
GitHub stars are fetched at build time. Analytics remains disabled unless its
public build configuration and proxy are deliberately supplied.
