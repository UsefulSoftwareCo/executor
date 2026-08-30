# @executor-js/local

## 1.6.6

### Patch Changes

- [#1865](https://github.com/UsefulSoftwareCo/executor/pull/1865) [`9a1fbd5`](https://github.com/UsefulSoftwareCo/executor/commit/9a1fbd5f0de25f622f303c76f998443c1bb72063) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - **Desktop OAuth connects finish the moment the provider redirects**

  When the desktop app runs an OAuth flow in the system browser, the app learned about completion by polling the local server once a second. The completed result sat in memory while the user watched the "Connecting…" spinner for up to a second more — about half a second wasted on average, on every connect.

  The await endpoint now long-polls: the server holds the request open (up to 25 seconds per hold) and answers the instant the flow completes. The client polls one request at a time and reconnects after each answer, so requests never stack. Mixed versions stay compatible in both directions: an old client still gets its answer within one poll of a new server, and a new client against an old server behaves exactly as before.

- Updated dependencies [[`c695970`](https://github.com/UsefulSoftwareCo/executor/commit/c6959702f6459504463fe0e13fa1a576190460ed), [`21119da`](https://github.com/UsefulSoftwareCo/executor/commit/21119da662d2d225b033b3532e1f17d97311a39d), [`9a1fbd5`](https://github.com/UsefulSoftwareCo/executor/commit/9a1fbd5f0de25f622f303c76f998443c1bb72063)]:
  - @executor-js/plugin-mcp@1.6.6
  - @executor-js/execution@1.6.6
  - @executor-js/react@1.4.69
  - @executor-js/analytics@0.1.13
  - @executor-js/api@1.4.69
  - @executor-js/host-mcp@1.4.4
  - @executor-js/mcp-apps-shell@1.4.17
  - @executor-js/app@1.4.4
  - @executor-js/plugin-graphql@1.6.6
  - @executor-js/plugin-onepassword@1.6.6
  - @executor-js/plugin-openapi@1.6.6
  - @executor-js/plugin-toolkits@1.5.41
  - @executor-js/plugin-provider-service-split@0.0.20
  - @executor-js/sdk@1.6.6
  - @executor-js/runtime-quickjs@1.6.6
  - @executor-js/config@1.6.6
  - @executor-js/plugin-file-secrets@1.6.6
  - @executor-js/plugin-keychain@1.6.6
  - @executor-js/plugin-example@1.6.6
  - @executor-js/plugin-desktop-settings@1.6.6
  - @executor-js/vite-plugin@0.0.66

## 1.6.5

### Patch Changes

- Updated dependencies [[`00c2ab7`](https://github.com/UsefulSoftwareCo/executor/commit/00c2ab789eef94efd9c05d389870566bba7111c2), [`4d4ad7c`](https://github.com/UsefulSoftwareCo/executor/commit/4d4ad7c1d5690bc13ad37d9cdadf3775e464a3f5)]:
  - @executor-js/plugin-mcp@1.6.5
  - @executor-js/sdk@1.6.5
  - @executor-js/runtime-quickjs@1.6.5
  - @executor-js/execution@1.6.5
  - @executor-js/config@1.6.5
  - @executor-js/plugin-file-secrets@1.6.5
  - @executor-js/plugin-graphql@1.6.5
  - @executor-js/plugin-keychain@1.6.5
  - @executor-js/plugin-onepassword@1.6.5
  - @executor-js/plugin-openapi@1.6.5
  - @executor-js/plugin-example@1.6.5
  - @executor-js/plugin-desktop-settings@1.6.5
  - @executor-js/app@1.4.4
  - @executor-js/analytics@0.1.12
  - @executor-js/api@1.4.68
  - @executor-js/vite-plugin@0.0.65
  - @executor-js/host-mcp@1.4.4
  - @executor-js/mcp-apps-shell@1.4.16
  - @executor-js/plugin-provider-service-split@0.0.19
  - @executor-js/plugin-toolkits@1.5.40
  - @executor-js/react@1.4.68

## 1.6.4

### Patch Changes

- Updated dependencies [[`ffcfbc0`](https://github.com/UsefulSoftwareCo/executor/commit/ffcfbc0de27d0ae55215839fb70395b0b7d9a65c), [`10e16a5`](https://github.com/UsefulSoftwareCo/executor/commit/10e16a5baa2648657b70038e7d11429c58e4d242), [`9dcfaa5`](https://github.com/UsefulSoftwareCo/executor/commit/9dcfaa5ee8ad2ebc17407caf94d8d4dcf55e3562), [`939b96f`](https://github.com/UsefulSoftwareCo/executor/commit/939b96f694a420cd6151c4e402cff7f1ab4b327a), [`515d6aa`](https://github.com/UsefulSoftwareCo/executor/commit/515d6aa391a04a3579a7b10f974ec316a563cf7a), [`06bf742`](https://github.com/UsefulSoftwareCo/executor/commit/06bf74254f3432e8d75fd8b493ef7a435ea4bc84), [`2cad774`](https://github.com/UsefulSoftwareCo/executor/commit/2cad7745dea1afb9282c3888f4e9c59ce6fe4332)]:
  - @executor-js/plugin-mcp@1.6.4
  - @executor-js/sdk@1.6.4
  - @executor-js/react@1.4.67
  - @executor-js/plugin-file-secrets@1.6.4
  - @executor-js/plugin-keychain@1.6.4
  - @executor-js/plugin-onepassword@1.6.4
  - @executor-js/app@1.4.4
  - @executor-js/analytics@0.1.11
  - @executor-js/api@1.4.67
  - @executor-js/config@1.6.4
  - @executor-js/execution@1.6.4
  - @executor-js/vite-plugin@0.0.64
  - @executor-js/host-mcp@1.4.4
  - @executor-js/mcp-apps-shell@1.4.15
  - @executor-js/plugin-desktop-settings@1.6.4
  - @executor-js/plugin-example@1.6.4
  - @executor-js/plugin-graphql@1.6.4
  - @executor-js/plugin-openapi@1.6.4
  - @executor-js/plugin-provider-service-split@0.0.18
  - @executor-js/plugin-toolkits@1.5.39
  - @executor-js/runtime-quickjs@1.6.4

## 1.6.3

### Patch Changes

- [#1458](https://github.com/UsefulSoftwareCo/executor/pull/1458) [`1908dd6`](https://github.com/UsefulSoftwareCo/executor/commit/1908dd6d7611489362d451f7594adca542c13ba1) Thanks [@tylergibbs1](https://github.com/tylergibbs1)! - **An unsupported method probed before `initialize` no longer kills the MCP connection**

  Only `initialize` can open a session, so the streamable-HTTP transport answered every other pre-session method with HTTP 400 + `-32000 Server not initialized`. A 400 is a transport-level failure, so clients dropped the connection instead of treating it as one request failing — a client that opens with an optional probe (MCP 2026-07-28 clients lead with `server/discover`) was disconnected before it could fall back to `initialize`. Over `executor mcp`, which bridges this endpoint to stdio, that closed the client's pipe outright.

  Pre-session dispatch now answers any method other than `initialize` with `-32601 Method not found` on a normal 200, which is a per-request error, so the connection survives and the handshake proceeds. This replaces only that one answer: a POST with a bad `Accept` or `Content-Type` still gets the transport's 406 or 415, and a message that is not a valid JSON-RPC request still gets its parse error.

- Updated dependencies [[`66fb1a4`](https://github.com/UsefulSoftwareCo/executor/commit/66fb1a4154226d28691ca83bdf6f3daa417ef0ce), [`4b0fbf6`](https://github.com/UsefulSoftwareCo/executor/commit/4b0fbf68550516af9235c9267f91a962da993946), [`ba62f1a`](https://github.com/UsefulSoftwareCo/executor/commit/ba62f1a5d14b7002ba0a4686a9e1ae43bd77f54f), [`8324e1e`](https://github.com/UsefulSoftwareCo/executor/commit/8324e1eb8b03965050147309f049bdb52be6fcad), [`6305b6d`](https://github.com/UsefulSoftwareCo/executor/commit/6305b6d11505358fa73ec2b3e768ec4256c36435), [`c1f51b7`](https://github.com/UsefulSoftwareCo/executor/commit/c1f51b7f96328b795669bb3d241667660dc2b060), [`d7e4b73`](https://github.com/UsefulSoftwareCo/executor/commit/d7e4b73a86b8e413af70e0fcb26f38a35a3f4546), [`85b1955`](https://github.com/UsefulSoftwareCo/executor/commit/85b1955b4d24c332e637e15a025d64455e28a626), [`02b52cd`](https://github.com/UsefulSoftwareCo/executor/commit/02b52cd01b09d3601ffe88d1f9c0b777f26e76ae)]:
  - @executor-js/react@1.4.66
  - @executor-js/plugin-mcp@1.6.3
  - @executor-js/sdk@1.6.3
  - @executor-js/plugin-openapi@1.6.3
  - @executor-js/fumadb@1.5.8
  - @executor-js/app@1.4.4
  - @executor-js/mcp-apps-shell@1.4.14
  - @executor-js/plugin-graphql@1.6.3
  - @executor-js/plugin-onepassword@1.6.3
  - @executor-js/plugin-toolkits@1.5.38
  - @executor-js/analytics@0.1.10
  - @executor-js/api@1.4.66
  - @executor-js/config@1.6.3
  - @executor-js/execution@1.6.3
  - @executor-js/vite-plugin@0.0.63
  - @executor-js/host-mcp@1.4.4
  - @executor-js/plugin-desktop-settings@1.6.3
  - @executor-js/plugin-example@1.6.3
  - @executor-js/plugin-file-secrets@1.6.3
  - @executor-js/plugin-keychain@1.6.3
  - @executor-js/plugin-provider-service-split@0.0.17
  - @executor-js/runtime-quickjs@1.6.3

## 1.6.2

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.6.2
  - @executor-js/runtime-quickjs@1.6.2
  - @executor-js/execution@1.6.2
  - @executor-js/config@1.6.2
  - @executor-js/plugin-file-secrets@1.6.2
  - @executor-js/plugin-graphql@1.6.2
  - @executor-js/plugin-keychain@1.6.2
  - @executor-js/plugin-mcp@1.6.2
  - @executor-js/plugin-onepassword@1.6.2
  - @executor-js/plugin-openapi@1.6.2
  - @executor-js/plugin-example@1.6.2
  - @executor-js/plugin-desktop-settings@1.6.2
  - @executor-js/app@1.4.4
  - @executor-js/analytics@0.1.9
  - @executor-js/api@1.4.65
  - @executor-js/vite-plugin@0.0.62
  - @executor-js/host-mcp@1.4.4
  - @executor-js/mcp-apps-shell@1.4.13
  - @executor-js/plugin-provider-service-split@0.0.16
  - @executor-js/plugin-toolkits@1.5.37
  - @executor-js/react@1.4.65

## 1.6.1

### Patch Changes

- Updated dependencies [[`9dff4e8`](https://github.com/UsefulSoftwareCo/executor/commit/9dff4e8e6598e7d3108634a71269245ba9b480bb), [`7c12aee`](https://github.com/UsefulSoftwareCo/executor/commit/7c12aeea390225291ce4c97865b392237ee7934d), [`ddbf0fe`](https://github.com/UsefulSoftwareCo/executor/commit/ddbf0feba38c8502d78fa20c3081391b8ba3d112), [`91062c2`](https://github.com/UsefulSoftwareCo/executor/commit/91062c2b1d7b8edbc8470ca5eaa544045652afaa), [`9c35f26`](https://github.com/UsefulSoftwareCo/executor/commit/9c35f269dd5de3548111fe5c83cf1e877f23c80d), [`62748e8`](https://github.com/UsefulSoftwareCo/executor/commit/62748e86122b747226c76c2e112c5c4d2b4f7095), [`0007474`](https://github.com/UsefulSoftwareCo/executor/commit/0007474602d8da3642648f216bfdb0f09eb0914f), [`d4afe0c`](https://github.com/UsefulSoftwareCo/executor/commit/d4afe0c79f146dd169a00988a2d5d0469297be19), [`55180cb`](https://github.com/UsefulSoftwareCo/executor/commit/55180cb1487f9a3a28ddc0ee0bedfab8464c1f72)]:
  - @executor-js/react@1.4.64
  - @executor-js/plugin-openapi@1.6.1
  - @executor-js/plugin-mcp@1.6.1
  - @executor-js/execution@1.6.1
  - @executor-js/sdk@1.6.1
  - @executor-js/api@1.4.64
  - @executor-js/app@1.4.4
  - @executor-js/mcp-apps-shell@1.4.12
  - @executor-js/plugin-graphql@1.6.1
  - @executor-js/plugin-onepassword@1.6.1
  - @executor-js/plugin-toolkits@1.5.36
  - @executor-js/plugin-provider-service-split@0.0.15
  - @executor-js/analytics@0.1.8
  - @executor-js/host-mcp@1.4.4
  - @executor-js/config@1.6.1
  - @executor-js/vite-plugin@0.0.61
  - @executor-js/plugin-desktop-settings@1.6.1
  - @executor-js/plugin-example@1.6.1
  - @executor-js/plugin-file-secrets@1.6.1
  - @executor-js/plugin-keychain@1.6.1
  - @executor-js/runtime-quickjs@1.6.1

## 1.6.0

### Patch Changes

- Updated dependencies [[`c11bef2`](https://github.com/UsefulSoftwareCo/executor/commit/c11bef2cd049db7bbf51b15e18761b14acccb534), [`46cea2c`](https://github.com/UsefulSoftwareCo/executor/commit/46cea2cbb1f414ae58ac876819a51b11967909a6), [`a2d1417`](https://github.com/UsefulSoftwareCo/executor/commit/a2d141758e478274813c8c24d354e1fd0f66af49), [`2bdbedf`](https://github.com/UsefulSoftwareCo/executor/commit/2bdbedf257f54d7c209e8c856c618174c10d6bb3), [`0b0b74f`](https://github.com/UsefulSoftwareCo/executor/commit/0b0b74f673b8098c5248159be36c648097f3c87b), [`256e25e`](https://github.com/UsefulSoftwareCo/executor/commit/256e25e7b291b0c023bc7547d092004b66781bba)]:
  - @executor-js/plugin-mcp@1.6.0
  - @executor-js/plugin-openapi@1.6.0
  - @executor-js/sdk@1.6.0
  - @executor-js/react@1.4.63
  - @executor-js/plugin-provider-service-split@0.0.14
  - @executor-js/app@1.4.4
  - @executor-js/analytics@0.1.7
  - @executor-js/api@1.4.63
  - @executor-js/config@1.6.0
  - @executor-js/execution@1.6.0
  - @executor-js/vite-plugin@0.0.60
  - @executor-js/host-mcp@1.4.4
  - @executor-js/mcp-apps-shell@1.4.11
  - @executor-js/plugin-desktop-settings@1.6.0
  - @executor-js/plugin-example@1.6.0
  - @executor-js/plugin-file-secrets@1.6.0
  - @executor-js/plugin-graphql@1.6.0
  - @executor-js/plugin-keychain@1.6.0
  - @executor-js/plugin-onepassword@1.6.0
  - @executor-js/plugin-toolkits@1.5.35
  - @executor-js/runtime-quickjs@1.6.0

## 1.5.42

### Patch Changes

- Updated dependencies [[`d3f0617`](https://github.com/UsefulSoftwareCo/executor/commit/d3f0617deec06c57e0d6e1479fe668f79daf977d), [`32206c7`](https://github.com/UsefulSoftwareCo/executor/commit/32206c7f78654f638bfd27c25c71c30c3d6354be), [`9ecc7cb`](https://github.com/UsefulSoftwareCo/executor/commit/9ecc7cb8b30375ffa960e3fefe4d211e0254e691)]:
  - @executor-js/sdk@1.5.42
  - @executor-js/plugin-openapi@1.5.42
  - @executor-js/plugin-mcp@1.5.42
  - @executor-js/app@1.4.4
  - @executor-js/analytics@0.1.6
  - @executor-js/api@1.4.62
  - @executor-js/config@1.5.42
  - @executor-js/execution@1.5.42
  - @executor-js/vite-plugin@0.0.59
  - @executor-js/host-mcp@1.4.4
  - @executor-js/mcp-apps-shell@1.4.10
  - @executor-js/plugin-desktop-settings@1.5.42
  - @executor-js/plugin-example@1.5.42
  - @executor-js/plugin-file-secrets@1.5.42
  - @executor-js/plugin-graphql@1.5.42
  - @executor-js/plugin-keychain@1.5.42
  - @executor-js/plugin-onepassword@1.5.42
  - @executor-js/plugin-provider-service-split@0.0.13
  - @executor-js/plugin-toolkits@1.5.34
  - @executor-js/react@1.4.62
  - @executor-js/runtime-quickjs@1.5.42

## 1.5.41

### Patch Changes

- Updated dependencies [[`d572658`](https://github.com/UsefulSoftwareCo/executor/commit/d572658d74097917412256f10a3ea2e3974f44dd), [`a9b33d2`](https://github.com/UsefulSoftwareCo/executor/commit/a9b33d25c32fbb4a292b7e8963e22392f862a16f)]:
  - @executor-js/sdk@1.5.41
  - @executor-js/plugin-mcp@1.5.41
  - @executor-js/app@1.4.4
  - @executor-js/analytics@0.1.5
  - @executor-js/api@1.4.61
  - @executor-js/config@1.5.41
  - @executor-js/execution@1.5.41
  - @executor-js/vite-plugin@0.0.58
  - @executor-js/host-mcp@1.4.4
  - @executor-js/mcp-apps-shell@1.4.9
  - @executor-js/plugin-desktop-settings@1.5.41
  - @executor-js/plugin-example@1.5.41
  - @executor-js/plugin-file-secrets@1.5.41
  - @executor-js/plugin-graphql@1.5.41
  - @executor-js/plugin-keychain@1.5.41
  - @executor-js/plugin-onepassword@1.5.41
  - @executor-js/plugin-openapi@1.5.41
  - @executor-js/plugin-provider-service-split@0.0.12
  - @executor-js/plugin-toolkits@1.5.33
  - @executor-js/react@1.4.61
  - @executor-js/runtime-quickjs@1.5.41

## 1.5.40

### Patch Changes

- [#1534](https://github.com/UsefulSoftwareCo/executor/pull/1534) [`80e5530`](https://github.com/UsefulSoftwareCo/executor/commit/80e553026278b1ecd7807f1ba99ba13b19d2c336) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - Report the real product surface and version in the integrations.sh registry user-agent. The daemon previously sent `local` with a version frozen at 1.4.4; it now reports `cli` or `desktop` (matching analytics surfaces) and `@executor-js/local` is versioned with the release train.

- Updated dependencies [[`8ba64f6`](https://github.com/UsefulSoftwareCo/executor/commit/8ba64f675f6d6ab5302d4f68390c0b055d006f4a)]:
  - @executor-js/sdk@1.5.40
  - @executor-js/app@1.4.4
  - @executor-js/analytics@0.1.4
  - @executor-js/api@1.4.60
  - @executor-js/config@1.5.40
  - @executor-js/execution@1.5.40
  - @executor-js/vite-plugin@0.0.57
  - @executor-js/host-mcp@1.4.4
  - @executor-js/mcp-apps-shell@1.4.8
  - @executor-js/plugin-desktop-settings@1.5.40
  - @executor-js/plugin-example@1.5.40
  - @executor-js/plugin-file-secrets@1.5.40
  - @executor-js/plugin-graphql@1.5.40
  - @executor-js/plugin-keychain@1.5.40
  - @executor-js/plugin-mcp@1.5.40
  - @executor-js/plugin-onepassword@1.5.40
  - @executor-js/plugin-openapi@1.5.40
  - @executor-js/plugin-provider-service-split@0.0.11
  - @executor-js/plugin-toolkits@1.5.32
  - @executor-js/react@1.4.60
  - @executor-js/runtime-quickjs@1.5.40
