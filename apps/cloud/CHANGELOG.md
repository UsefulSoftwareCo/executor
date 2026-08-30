# @executor-js/cloud

## 1.4.67

### Patch Changes

- [#1864](https://github.com/UsefulSoftwareCo/executor/pull/1864) [`fad3650`](https://github.com/UsefulSoftwareCo/executor/commit/fad36504439a07e6080beba243b24b73cd1b9741) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - **API key validation is cached per isolate**

  Every MCP request and every API-key-authenticated `/api/*` request used to pay a live WorkOS round trip (~100-150ms) to validate the presented key, on every single request. The JWT bearer path beside it already verified locally against a JWKS cached for an hour; API keys had no cache at all.

  Successful validations are now cached in a bounded per-isolate map for 60 seconds, keyed by the SHA-256 digest of the key value (never the raw credential). The MCP handler used to rebuild its whole auth layer (and with it the cache) on every request; it now builds the layer once per isolate, so the cache holds on both the `/api/*` and `/mcp` planes. Invalid keys and upstream failures are never cached, so probing bad keys cannot pollute the map and a freshly created key works immediately. The tradeoff: a revoked key remains usable for up to 60 seconds within an isolate that validated it before revocation — far tighter than the one-hour rotation window the JWT path already accepts.

- Updated dependencies [[`c695970`](https://github.com/UsefulSoftwareCo/executor/commit/c6959702f6459504463fe0e13fa1a576190460ed), [`21119da`](https://github.com/UsefulSoftwareCo/executor/commit/21119da662d2d225b033b3532e1f17d97311a39d), [`9a1fbd5`](https://github.com/UsefulSoftwareCo/executor/commit/9a1fbd5f0de25f622f303c76f998443c1bb72063)]:
  - @executor-js/plugin-mcp@1.6.6
  - @executor-js/execution@1.6.6
  - @executor-js/react@1.4.69
  - @executor-js/api@1.4.69
  - @executor-js/cloudflare@0.0.48
  - @executor-js/host-mcp@1.4.4
  - @executor-js/mcp-apps-shell@1.4.17
  - @executor-js/runtime-dynamic-worker@1.4.4
  - @executor-js/plugin-graphql@1.6.6
  - @executor-js/plugin-openapi@1.6.6
  - @executor-js/plugin-toolkits@1.5.41
  - @executor-js/plugin-workos-vault@0.0.2
  - @executor-js/sdk@1.6.6
  - @executor-js/runtime-quickjs@1.6.6
  - @executor-js/vite-plugin@0.0.66

## 1.4.66

### Patch Changes

- Updated dependencies [[`00c2ab7`](https://github.com/UsefulSoftwareCo/executor/commit/00c2ab789eef94efd9c05d389870566bba7111c2), [`4d4ad7c`](https://github.com/UsefulSoftwareCo/executor/commit/4d4ad7c1d5690bc13ad37d9cdadf3775e464a3f5)]:
  - @executor-js/plugin-mcp@1.6.5
  - @executor-js/sdk@1.6.5
  - @executor-js/runtime-quickjs@1.6.5
  - @executor-js/execution@1.6.5
  - @executor-js/plugin-graphql@1.6.5
  - @executor-js/plugin-openapi@1.6.5
  - @executor-js/api@1.4.68
  - @executor-js/vite-plugin@0.0.65
  - @executor-js/cloudflare@0.0.47
  - @executor-js/host-mcp@1.4.4
  - @executor-js/mcp-apps-shell@1.4.16
  - @executor-js/runtime-dynamic-worker@1.4.4
  - @executor-js/plugin-toolkits@1.5.40
  - @executor-js/plugin-workos-vault@0.0.2
  - @executor-js/react@1.4.68

## 1.4.65

### Patch Changes

- Updated dependencies [[`ffcfbc0`](https://github.com/UsefulSoftwareCo/executor/commit/ffcfbc0de27d0ae55215839fb70395b0b7d9a65c), [`10e16a5`](https://github.com/UsefulSoftwareCo/executor/commit/10e16a5baa2648657b70038e7d11429c58e4d242), [`9dcfaa5`](https://github.com/UsefulSoftwareCo/executor/commit/9dcfaa5ee8ad2ebc17407caf94d8d4dcf55e3562), [`515d6aa`](https://github.com/UsefulSoftwareCo/executor/commit/515d6aa391a04a3579a7b10f974ec316a563cf7a), [`06bf742`](https://github.com/UsefulSoftwareCo/executor/commit/06bf74254f3432e8d75fd8b493ef7a435ea4bc84)]:
  - @executor-js/plugin-mcp@1.6.4
  - @executor-js/sdk@1.6.4
  - @executor-js/react@1.4.67
  - @executor-js/api@1.4.67
  - @executor-js/execution@1.6.4
  - @executor-js/vite-plugin@0.0.64
  - @executor-js/cloudflare@0.0.46
  - @executor-js/host-mcp@1.4.4
  - @executor-js/mcp-apps-shell@1.4.15
  - @executor-js/runtime-dynamic-worker@1.4.4
  - @executor-js/plugin-graphql@1.6.4
  - @executor-js/plugin-openapi@1.6.4
  - @executor-js/plugin-toolkits@1.5.39
  - @executor-js/plugin-workos-vault@0.0.2
  - @executor-js/runtime-quickjs@1.6.4

## 1.4.64

### Patch Changes

- [#1806](https://github.com/UsefulSoftwareCo/executor/pull/1806) [`93817ed`](https://github.com/UsefulSoftwareCo/executor/commit/93817ed43919934092a4706327f50f6adfd14e47) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - **Team pricing is per member with unlimited executions**

  The Team plan moves from $150 per organization with a 250,000-execution
  allowance to $15 per member per month with unlimited executions. The
  `members` feature is unarchived in `autumn.config.ts` and billed in arrears
  on the seat count the app reports; Free keeps its 3-member, 100,000-execution
  shape and Enterprise stays custom with seat usage tracked for visibility.

  Seat counts reconcile from a full WorkOS recount (active members only —
  pending invites hold a seat for the plan gate but are not billed) after
  member removal, invitation acceptance, organization creation, and on every
  login callback, which also picks up joins the app never sees a mutation for
  (SSO JIT provisioning, join by domain, dashboard edits). Plans that predate
  seat pricing have no members balance and are skipped, so existing
  subscriptions keep billing exactly as before on their current plan version.

  The plans page, billing page, and marketing pricing cards now show the
  per-member price.

- Updated dependencies [[`66fb1a4`](https://github.com/UsefulSoftwareCo/executor/commit/66fb1a4154226d28691ca83bdf6f3daa417ef0ce), [`4b0fbf6`](https://github.com/UsefulSoftwareCo/executor/commit/4b0fbf68550516af9235c9267f91a962da993946), [`ba62f1a`](https://github.com/UsefulSoftwareCo/executor/commit/ba62f1a5d14b7002ba0a4686a9e1ae43bd77f54f), [`8324e1e`](https://github.com/UsefulSoftwareCo/executor/commit/8324e1eb8b03965050147309f049bdb52be6fcad), [`6305b6d`](https://github.com/UsefulSoftwareCo/executor/commit/6305b6d11505358fa73ec2b3e768ec4256c36435), [`c1f51b7`](https://github.com/UsefulSoftwareCo/executor/commit/c1f51b7f96328b795669bb3d241667660dc2b060), [`d7e4b73`](https://github.com/UsefulSoftwareCo/executor/commit/d7e4b73a86b8e413af70e0fcb26f38a35a3f4546), [`85b1955`](https://github.com/UsefulSoftwareCo/executor/commit/85b1955b4d24c332e637e15a025d64455e28a626), [`02b52cd`](https://github.com/UsefulSoftwareCo/executor/commit/02b52cd01b09d3601ffe88d1f9c0b777f26e76ae)]:
  - @executor-js/react@1.4.66
  - @executor-js/plugin-mcp@1.6.3
  - @executor-js/sdk@1.6.3
  - @executor-js/plugin-openapi@1.6.3
  - @executor-js/fumadb@1.5.8
  - @executor-js/mcp-apps-shell@1.4.14
  - @executor-js/plugin-graphql@1.6.3
  - @executor-js/plugin-toolkits@1.5.38
  - @executor-js/plugin-workos-vault@0.0.2
  - @executor-js/api@1.4.66
  - @executor-js/execution@1.6.3
  - @executor-js/vite-plugin@0.0.63
  - @executor-js/cloudflare@0.0.45
  - @executor-js/host-mcp@1.4.4
  - @executor-js/runtime-dynamic-worker@1.4.4
  - @executor-js/runtime-quickjs@1.6.3

## 1.4.63

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.6.2
  - @executor-js/runtime-quickjs@1.6.2
  - @executor-js/execution@1.6.2
  - @executor-js/plugin-graphql@1.6.2
  - @executor-js/plugin-mcp@1.6.2
  - @executor-js/plugin-openapi@1.6.2
  - @executor-js/api@1.4.65
  - @executor-js/vite-plugin@0.0.62
  - @executor-js/cloudflare@0.0.44
  - @executor-js/host-mcp@1.4.4
  - @executor-js/mcp-apps-shell@1.4.13
  - @executor-js/runtime-dynamic-worker@1.4.4
  - @executor-js/plugin-toolkits@1.5.37
  - @executor-js/plugin-workos-vault@0.0.2
  - @executor-js/react@1.4.65

## 1.4.62

### Patch Changes

- Updated dependencies [[`9dff4e8`](https://github.com/UsefulSoftwareCo/executor/commit/9dff4e8e6598e7d3108634a71269245ba9b480bb), [`7c12aee`](https://github.com/UsefulSoftwareCo/executor/commit/7c12aeea390225291ce4c97865b392237ee7934d), [`ddbf0fe`](https://github.com/UsefulSoftwareCo/executor/commit/ddbf0feba38c8502d78fa20c3081391b8ba3d112), [`91062c2`](https://github.com/UsefulSoftwareCo/executor/commit/91062c2b1d7b8edbc8470ca5eaa544045652afaa), [`9c35f26`](https://github.com/UsefulSoftwareCo/executor/commit/9c35f269dd5de3548111fe5c83cf1e877f23c80d), [`62748e8`](https://github.com/UsefulSoftwareCo/executor/commit/62748e86122b747226c76c2e112c5c4d2b4f7095), [`0007474`](https://github.com/UsefulSoftwareCo/executor/commit/0007474602d8da3642648f216bfdb0f09eb0914f), [`d4afe0c`](https://github.com/UsefulSoftwareCo/executor/commit/d4afe0c79f146dd169a00988a2d5d0469297be19), [`55180cb`](https://github.com/UsefulSoftwareCo/executor/commit/55180cb1487f9a3a28ddc0ee0bedfab8464c1f72)]:
  - @executor-js/react@1.4.64
  - @executor-js/plugin-openapi@1.6.1
  - @executor-js/plugin-mcp@1.6.1
  - @executor-js/execution@1.6.1
  - @executor-js/sdk@1.6.1
  - @executor-js/api@1.4.64
  - @executor-js/mcp-apps-shell@1.4.12
  - @executor-js/plugin-graphql@1.6.1
  - @executor-js/plugin-toolkits@1.5.36
  - @executor-js/plugin-workos-vault@0.0.2
  - @executor-js/runtime-dynamic-worker@1.4.4
  - @executor-js/cloudflare@0.0.43
  - @executor-js/host-mcp@1.4.4
  - @executor-js/vite-plugin@0.0.61
  - @executor-js/runtime-quickjs@1.6.1

## 1.4.61

### Patch Changes

- Updated dependencies [[`c11bef2`](https://github.com/UsefulSoftwareCo/executor/commit/c11bef2cd049db7bbf51b15e18761b14acccb534), [`46cea2c`](https://github.com/UsefulSoftwareCo/executor/commit/46cea2cbb1f414ae58ac876819a51b11967909a6), [`a2d1417`](https://github.com/UsefulSoftwareCo/executor/commit/a2d141758e478274813c8c24d354e1fd0f66af49), [`2bdbedf`](https://github.com/UsefulSoftwareCo/executor/commit/2bdbedf257f54d7c209e8c856c618174c10d6bb3), [`0b0b74f`](https://github.com/UsefulSoftwareCo/executor/commit/0b0b74f673b8098c5248159be36c648097f3c87b), [`256e25e`](https://github.com/UsefulSoftwareCo/executor/commit/256e25e7b291b0c023bc7547d092004b66781bba)]:
  - @executor-js/plugin-mcp@1.6.0
  - @executor-js/plugin-openapi@1.6.0
  - @executor-js/sdk@1.6.0
  - @executor-js/react@1.4.63
  - @executor-js/runtime-dynamic-worker@1.4.4
  - @executor-js/api@1.4.63
  - @executor-js/execution@1.6.0
  - @executor-js/vite-plugin@0.0.60
  - @executor-js/cloudflare@0.0.42
  - @executor-js/host-mcp@1.4.4
  - @executor-js/mcp-apps-shell@1.4.11
  - @executor-js/plugin-graphql@1.6.0
  - @executor-js/plugin-toolkits@1.5.35
  - @executor-js/plugin-workos-vault@0.0.2
  - @executor-js/runtime-quickjs@1.6.0

## 1.4.60

### Patch Changes

- Updated dependencies [[`d3f0617`](https://github.com/UsefulSoftwareCo/executor/commit/d3f0617deec06c57e0d6e1479fe668f79daf977d), [`86c68af`](https://github.com/UsefulSoftwareCo/executor/commit/86c68afef9bf8b7c19ab58f59acfedca0b3c4ca7), [`32206c7`](https://github.com/UsefulSoftwareCo/executor/commit/32206c7f78654f638bfd27c25c71c30c3d6354be), [`9ecc7cb`](https://github.com/UsefulSoftwareCo/executor/commit/9ecc7cb8b30375ffa960e3fefe4d211e0254e691)]:
  - @executor-js/sdk@1.5.42
  - @executor-js/cloudflare@0.0.41
  - @executor-js/plugin-openapi@1.5.42
  - @executor-js/plugin-mcp@1.5.42
  - @executor-js/api@1.4.62
  - @executor-js/execution@1.5.42
  - @executor-js/vite-plugin@0.0.59
  - @executor-js/host-mcp@1.4.4
  - @executor-js/mcp-apps-shell@1.4.10
  - @executor-js/runtime-dynamic-worker@1.4.4
  - @executor-js/plugin-graphql@1.5.42
  - @executor-js/plugin-toolkits@1.5.34
  - @executor-js/plugin-workos-vault@0.0.2
  - @executor-js/react@1.4.62
  - @executor-js/runtime-quickjs@1.5.42

## 1.4.59

### Patch Changes

- Updated dependencies [[`d572658`](https://github.com/UsefulSoftwareCo/executor/commit/d572658d74097917412256f10a3ea2e3974f44dd), [`a9b33d2`](https://github.com/UsefulSoftwareCo/executor/commit/a9b33d25c32fbb4a292b7e8963e22392f862a16f)]:
  - @executor-js/sdk@1.5.41
  - @executor-js/plugin-mcp@1.5.41
  - @executor-js/api@1.4.61
  - @executor-js/execution@1.5.41
  - @executor-js/vite-plugin@0.0.58
  - @executor-js/cloudflare@0.0.40
  - @executor-js/host-mcp@1.4.4
  - @executor-js/mcp-apps-shell@1.4.9
  - @executor-js/runtime-dynamic-worker@1.4.4
  - @executor-js/plugin-graphql@1.5.41
  - @executor-js/plugin-openapi@1.5.41
  - @executor-js/plugin-toolkits@1.5.33
  - @executor-js/plugin-workos-vault@0.0.2
  - @executor-js/react@1.4.61
  - @executor-js/runtime-quickjs@1.5.41

## 1.4.58

### Patch Changes

- Updated dependencies [[`8ba64f6`](https://github.com/UsefulSoftwareCo/executor/commit/8ba64f675f6d6ab5302d4f68390c0b055d006f4a)]:
  - @executor-js/sdk@1.5.40
  - @executor-js/api@1.4.60
  - @executor-js/execution@1.5.40
  - @executor-js/vite-plugin@0.0.57
  - @executor-js/cloudflare@0.0.39
  - @executor-js/host-mcp@1.4.4
  - @executor-js/mcp-apps-shell@1.4.8
  - @executor-js/runtime-dynamic-worker@1.4.4
  - @executor-js/plugin-graphql@1.5.40
  - @executor-js/plugin-mcp@1.5.40
  - @executor-js/plugin-openapi@1.5.40
  - @executor-js/plugin-toolkits@1.5.32
  - @executor-js/plugin-workos-vault@0.0.2
  - @executor-js/react@1.4.60
  - @executor-js/runtime-quickjs@1.5.40

## 1.4.57

### Patch Changes

- Updated dependencies [[`6c316c7`](https://github.com/UsefulSoftwareCo/executor/commit/6c316c77a9efc98784976236852b58c6156e016e)]:
  - @executor-js/sdk@1.5.39
  - @executor-js/api@1.4.59
  - @executor-js/execution@1.5.39
  - @executor-js/vite-plugin@0.0.56
  - @executor-js/cloudflare@0.0.38
  - @executor-js/host-mcp@1.4.4
  - @executor-js/mcp-apps-shell@1.4.7
  - @executor-js/runtime-dynamic-worker@1.4.4
  - @executor-js/plugin-graphql@1.5.39
  - @executor-js/plugin-mcp@1.5.39
  - @executor-js/plugin-openapi@1.5.39
  - @executor-js/plugin-toolkits@1.5.31
  - @executor-js/plugin-workos-vault@0.0.2
  - @executor-js/react@1.4.59
  - @executor-js/runtime-quickjs@1.5.39

## 1.4.56

### Patch Changes

- Updated dependencies [[`df01d91`](https://github.com/UsefulSoftwareCo/executor/commit/df01d9197e7b4fca9bd0adaca0705a80435e188c), [`6a924dd`](https://github.com/UsefulSoftwareCo/executor/commit/6a924dd98de916d6ff8cea2329bf672f149b64f4), [`1de85fc`](https://github.com/UsefulSoftwareCo/executor/commit/1de85fc0201c0c23c0e71e003c49228d406af6c8)]:
  - @executor-js/plugin-openapi@1.5.38
  - @executor-js/sdk@1.5.38
  - @executor-js/react@1.4.58
  - @executor-js/runtime-dynamic-worker@1.4.4
  - @executor-js/api@1.4.58
  - @executor-js/execution@1.5.38
  - @executor-js/vite-plugin@0.0.55
  - @executor-js/cloudflare@0.0.37
  - @executor-js/host-mcp@1.4.4
  - @executor-js/mcp-apps-shell@1.4.6
  - @executor-js/plugin-graphql@1.5.38
  - @executor-js/plugin-mcp@1.5.38
  - @executor-js/plugin-toolkits@1.5.30
  - @executor-js/plugin-workos-vault@0.0.2
  - @executor-js/runtime-quickjs@1.5.38

## 1.4.55

### Patch Changes

- Updated dependencies [[`657b913`](https://github.com/UsefulSoftwareCo/executor/commit/657b9135b8b841495b362936bf60bdca998c16eb)]:
  - @executor-js/sdk@1.5.37
  - @executor-js/api@1.4.57
  - @executor-js/execution@1.5.37
  - @executor-js/vite-plugin@0.0.54
  - @executor-js/cloudflare@0.0.36
  - @executor-js/host-mcp@1.4.4
  - @executor-js/mcp-apps-shell@1.4.5
  - @executor-js/runtime-dynamic-worker@1.4.4
  - @executor-js/plugin-graphql@1.5.37
  - @executor-js/plugin-mcp@1.5.37
  - @executor-js/plugin-openapi@1.5.37
  - @executor-js/plugin-toolkits@1.5.29
  - @executor-js/plugin-workos-vault@0.0.2
  - @executor-js/react@1.4.57
  - @executor-js/runtime-quickjs@1.5.37

## 1.4.54

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.36
  - @executor-js/runtime-quickjs@1.5.36
  - @executor-js/execution@1.5.36
  - @executor-js/plugin-graphql@1.5.36
  - @executor-js/plugin-mcp@1.5.36
  - @executor-js/plugin-openapi@1.5.36
  - @executor-js/api@1.4.56
  - @executor-js/vite-plugin@0.0.53
  - @executor-js/cloudflare@0.0.35
  - @executor-js/host-mcp@1.4.4
  - @executor-js/runtime-dynamic-worker@1.4.4
  - @executor-js/plugin-toolkits@1.5.28
  - @executor-js/plugin-workos-vault@0.0.2
  - @executor-js/react@1.4.56

## 1.4.53

### Patch Changes

- Updated dependencies [[`1b9b1f1`](https://github.com/UsefulSoftwareCo/executor/commit/1b9b1f10313834a625a411169ebf83f6181589df), [`af95edb`](https://github.com/UsefulSoftwareCo/executor/commit/af95edbb0bbde544bb1f4c6e18e9d64a2bcab0f8), [`99c808f`](https://github.com/UsefulSoftwareCo/executor/commit/99c808f09d3cf2263945efa4f6592cc4e78c9e08)]:
  - @executor-js/sdk@1.5.35
  - @executor-js/plugin-mcp@1.5.35
  - @executor-js/runtime-quickjs@1.5.35
  - @executor-js/api@1.4.55
  - @executor-js/execution@1.5.35
  - @executor-js/vite-plugin@0.0.52
  - @executor-js/cloudflare@0.0.34
  - @executor-js/host-mcp@1.4.4
  - @executor-js/runtime-dynamic-worker@1.4.4
  - @executor-js/plugin-apps@0.1.6
  - @executor-js/plugin-graphql@1.5.35
  - @executor-js/plugin-openapi@1.5.35
  - @executor-js/plugin-toolkits@1.5.27
  - @executor-js/plugin-workos-vault@0.0.2
  - @executor-js/react@1.4.55

## 1.4.52

### Patch Changes

- Updated dependencies [[`e2712db`](https://github.com/UsefulSoftwareCo/executor/commit/e2712dbff98145c5c340832ffbdcb21113b9dd78), [`a86cc4e`](https://github.com/UsefulSoftwareCo/executor/commit/a86cc4e6d0252c90834f40ee09837d8a19cab7fe), [`7207347`](https://github.com/UsefulSoftwareCo/executor/commit/720734756a70b1b4f1564bdf82dc4118e5de2b76), [`0c4e9b4`](https://github.com/UsefulSoftwareCo/executor/commit/0c4e9b49fecb35ad71c92a464c3ea01131ff9d6f), [`171de20`](https://github.com/UsefulSoftwareCo/executor/commit/171de204725d10405c693549febc3a1cce2c24d8)]:
  - @executor-js/sdk@1.5.34
  - @executor-js/execution@1.5.34
  - @executor-js/plugin-openapi@1.5.34
  - @executor-js/api@1.4.54
  - @executor-js/vite-plugin@0.0.51
  - @executor-js/cloudflare@0.0.33
  - @executor-js/host-mcp@1.4.4
  - @executor-js/runtime-dynamic-worker@1.4.4
  - @executor-js/plugin-apps@0.1.5
  - @executor-js/plugin-graphql@1.5.34
  - @executor-js/plugin-mcp@1.5.34
  - @executor-js/plugin-toolkits@1.5.26
  - @executor-js/plugin-workos-vault@0.0.2
  - @executor-js/react@1.4.54
  - @executor-js/runtime-quickjs@1.5.34

## 1.4.51

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.33
  - @executor-js/runtime-quickjs@1.5.33
  - @executor-js/execution@1.5.33
  - @executor-js/plugin-graphql@1.5.33
  - @executor-js/plugin-mcp@1.5.33
  - @executor-js/plugin-openapi@1.5.33
  - @executor-js/api@1.4.53
  - @executor-js/vite-plugin@0.0.50
  - @executor-js/cloudflare@0.0.32
  - @executor-js/host-mcp@1.4.4
  - @executor-js/runtime-dynamic-worker@1.4.4
  - @executor-js/plugin-apps@0.1.4
  - @executor-js/plugin-toolkits@1.5.25
  - @executor-js/plugin-workos-vault@0.0.2
  - @executor-js/react@1.4.53

## 1.4.50

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.32
  - @executor-js/runtime-quickjs@1.5.32
  - @executor-js/execution@1.5.32
  - @executor-js/plugin-graphql@1.5.32
  - @executor-js/plugin-mcp@1.5.32
  - @executor-js/plugin-openapi@1.5.32
  - @executor-js/api@1.4.52
  - @executor-js/vite-plugin@0.0.49
  - @executor-js/cloudflare@0.0.31
  - @executor-js/host-mcp@1.4.4
  - @executor-js/runtime-dynamic-worker@1.4.4
  - @executor-js/plugin-apps@0.1.3
  - @executor-js/plugin-toolkits@1.5.24
  - @executor-js/plugin-workos-vault@0.0.2
  - @executor-js/react@1.4.52

## 1.4.49

### Patch Changes

- Updated dependencies [[`9e38928`](https://github.com/UsefulSoftwareCo/executor/commit/9e38928f0fda9032b64b26990270c5d2b6690d13)]:
  - @executor-js/plugin-openapi@1.5.31
  - @executor-js/runtime-dynamic-worker@1.4.4
  - @executor-js/sdk@1.5.31
  - @executor-js/runtime-quickjs@1.5.31
  - @executor-js/execution@1.5.31
  - @executor-js/plugin-graphql@1.5.31
  - @executor-js/plugin-mcp@1.5.31
  - @executor-js/api@1.4.51
  - @executor-js/vite-plugin@0.0.48
  - @executor-js/cloudflare@0.0.30
  - @executor-js/host-mcp@1.4.4
  - @executor-js/plugin-apps@0.1.2
  - @executor-js/plugin-toolkits@1.5.23
  - @executor-js/plugin-workos-vault@0.0.2
  - @executor-js/react@1.4.51

## 1.4.48

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.30
  - @executor-js/runtime-quickjs@1.5.30
  - @executor-js/execution@1.5.30
  - @executor-js/plugin-graphql@1.5.30
  - @executor-js/plugin-mcp@1.5.30
  - @executor-js/plugin-openapi@1.5.30
  - @executor-js/api@1.4.50
  - @executor-js/vite-plugin@0.0.47
  - @executor-js/cloudflare@0.0.29
  - @executor-js/host-mcp@1.4.4
  - @executor-js/runtime-dynamic-worker@1.4.4
  - @executor-js/plugin-apps@0.1.1
  - @executor-js/plugin-toolkits@1.5.22
  - @executor-js/plugin-workos-vault@0.0.2
  - @executor-js/react@1.4.50

## 1.4.47

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.29
  - @executor-js/runtime-quickjs@1.5.29
  - @executor-js/execution@1.5.29
  - @executor-js/plugin-graphql@1.5.29
  - @executor-js/plugin-mcp@1.5.29
  - @executor-js/plugin-openapi@1.5.29
  - @executor-js/api@1.4.49
  - @executor-js/vite-plugin@0.0.46
  - @executor-js/cloudflare@0.0.28
  - @executor-js/host-mcp@1.4.4
  - @executor-js/runtime-dynamic-worker@1.4.4
  - @executor-js/plugin-google@1.5.28
  - @executor-js/plugin-microsoft@1.5.28
  - @executor-js/plugin-toolkits@1.5.21
  - @executor-js/plugin-workos-vault@0.0.2
  - @executor-js/react@1.4.49

## 1.4.46

### Patch Changes

- Updated dependencies [[`747f4e1`](https://github.com/UsefulSoftwareCo/executor/commit/747f4e190a4821dc942b739b354e0b099d4b284d), [`1c48182`](https://github.com/UsefulSoftwareCo/executor/commit/1c4818254e71dc4ee27ff95f489e2c5cf330a450)]:
  - @executor-js/cloudflare@0.0.27
  - @executor-js/plugin-mcp@1.5.28
  - @executor-js/sdk@1.5.28
  - @executor-js/api@1.4.48
  - @executor-js/execution@1.5.28
  - @executor-js/vite-plugin@0.0.45
  - @executor-js/host-mcp@1.4.4
  - @executor-js/runtime-dynamic-worker@1.4.4
  - @executor-js/plugin-google@1.5.27
  - @executor-js/plugin-graphql@1.5.28
  - @executor-js/plugin-microsoft@1.5.27
  - @executor-js/plugin-openapi@1.5.28
  - @executor-js/plugin-toolkits@1.5.20
  - @executor-js/plugin-workos-vault@0.0.2
  - @executor-js/react@1.4.48
  - @executor-js/runtime-quickjs@1.5.28

## 1.4.45

### Patch Changes

- Updated dependencies [[`c7ab1e2`](https://github.com/RhysSullivan/executor/commit/c7ab1e2d56884e0453af85f6399fd25a39f04785)]:
  - @executor-js/api@1.4.47
  - @executor-js/cloudflare@0.0.26
  - @executor-js/plugin-google@1.5.26
  - @executor-js/plugin-graphql@1.5.27
  - @executor-js/plugin-mcp@1.5.27
  - @executor-js/plugin-microsoft@1.5.26
  - @executor-js/plugin-openapi@1.5.27
  - @executor-js/plugin-toolkits@1.5.19
  - @executor-js/react@1.4.47
  - @executor-js/runtime-dynamic-worker@1.4.4
  - @executor-js/plugin-workos-vault@0.0.2
  - @executor-js/sdk@1.5.27
  - @executor-js/runtime-quickjs@1.5.27
  - @executor-js/execution@1.5.27
  - @executor-js/vite-plugin@0.0.44
  - @executor-js/host-mcp@1.4.4

## 1.4.44

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.26
  - @executor-js/runtime-quickjs@1.5.26
  - @executor-js/execution@1.5.26
  - @executor-js/plugin-graphql@1.5.26
  - @executor-js/plugin-mcp@1.5.26
  - @executor-js/plugin-openapi@1.5.26
  - @executor-js/api@1.4.46
  - @executor-js/vite-plugin@0.0.43
  - @executor-js/cloudflare@0.0.25
  - @executor-js/host-mcp@1.4.4
  - @executor-js/runtime-dynamic-worker@1.4.4
  - @executor-js/plugin-google@1.5.25
  - @executor-js/plugin-microsoft@1.5.25
  - @executor-js/plugin-toolkits@1.5.18
  - @executor-js/plugin-workos-vault@0.0.2
  - @executor-js/react@1.4.46

## 1.4.43

### Patch Changes

- Updated dependencies [[`dc9bf71`](https://github.com/RhysSullivan/executor/commit/dc9bf717b81a3b719a137b25d01a8fd28e6cd699)]:
  - @executor-js/plugin-openapi@1.5.25
  - @executor-js/runtime-dynamic-worker@1.4.4
  - @executor-js/plugin-google@1.5.24
  - @executor-js/plugin-microsoft@1.5.24
  - @executor-js/sdk@1.5.25
  - @executor-js/runtime-quickjs@1.5.25
  - @executor-js/execution@1.5.25
  - @executor-js/plugin-graphql@1.5.25
  - @executor-js/plugin-mcp@1.5.25
  - @executor-js/api@1.4.45
  - @executor-js/vite-plugin@0.0.42
  - @executor-js/cloudflare@0.0.24
  - @executor-js/host-mcp@1.4.4
  - @executor-js/plugin-toolkits@1.5.17
  - @executor-js/plugin-workos-vault@0.0.2
  - @executor-js/react@1.4.45

## 1.4.42

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.24
  - @executor-js/runtime-quickjs@1.5.24
  - @executor-js/execution@1.5.24
  - @executor-js/plugin-graphql@1.5.24
  - @executor-js/plugin-mcp@1.5.24
  - @executor-js/plugin-openapi@1.5.24
  - @executor-js/api@1.4.44
  - @executor-js/vite-plugin@0.0.41
  - @executor-js/cloudflare@0.0.23
  - @executor-js/host-mcp@1.4.4
  - @executor-js/runtime-dynamic-worker@1.4.4
  - @executor-js/plugin-google@1.5.23
  - @executor-js/plugin-microsoft@1.5.23
  - @executor-js/plugin-toolkits@1.5.16
  - @executor-js/plugin-workos-vault@0.0.2
  - @executor-js/react@1.4.44

## 1.4.41

### Patch Changes

- Updated dependencies [[`29936d5`](https://github.com/RhysSullivan/executor/commit/29936d5981256f8f953797d9ce8ce073ac6a0b6a), [`29936d5`](https://github.com/RhysSullivan/executor/commit/29936d5981256f8f953797d9ce8ce073ac6a0b6a), [`29936d5`](https://github.com/RhysSullivan/executor/commit/29936d5981256f8f953797d9ce8ce073ac6a0b6a)]:
  - @executor-js/api@1.4.43
  - @executor-js/plugin-graphql@1.5.23
  - @executor-js/react@1.4.43
  - @executor-js/cloudflare@0.0.22
  - @executor-js/plugin-google@1.5.22
  - @executor-js/plugin-mcp@1.5.23
  - @executor-js/plugin-microsoft@1.5.22
  - @executor-js/plugin-openapi@1.5.23
  - @executor-js/plugin-toolkits@1.5.15
  - @executor-js/plugin-workos-vault@0.0.2
  - @executor-js/runtime-dynamic-worker@1.4.4
  - @executor-js/sdk@1.5.23
  - @executor-js/runtime-quickjs@1.5.23
  - @executor-js/execution@1.5.23
  - @executor-js/vite-plugin@0.0.40
  - @executor-js/host-mcp@1.4.4

## 1.4.40

### Patch Changes

- Updated dependencies [[`1a1f9aa`](https://github.com/RhysSullivan/executor/commit/1a1f9aaae4e4d0f73311fd643919cdfaa637c124)]:
  - @executor-js/plugin-google@1.5.21
  - @executor-js/plugin-openapi@1.5.22
  - @executor-js/runtime-dynamic-worker@1.4.4
  - @executor-js/plugin-microsoft@1.5.21
  - @executor-js/sdk@1.5.22
  - @executor-js/runtime-quickjs@1.5.22
  - @executor-js/execution@1.5.22
  - @executor-js/plugin-graphql@1.5.22
  - @executor-js/plugin-mcp@1.5.22
  - @executor-js/api@1.4.42
  - @executor-js/vite-plugin@0.0.39
  - @executor-js/cloudflare@0.0.21
  - @executor-js/host-mcp@1.4.4
  - @executor-js/plugin-toolkits@1.5.14
  - @executor-js/plugin-workos-vault@0.0.2
  - @executor-js/react@1.4.42

## 1.4.39

### Patch Changes

- Updated dependencies [[`4b361b9`](https://github.com/RhysSullivan/executor/commit/4b361b9f7220f679f582137f5375b29c3b72f919)]:
  - @executor-js/plugin-openapi@1.5.21
  - @executor-js/runtime-dynamic-worker@1.4.4
  - @executor-js/plugin-google@1.5.20
  - @executor-js/plugin-microsoft@1.5.20
  - @executor-js/sdk@1.5.21
  - @executor-js/runtime-quickjs@1.5.21
  - @executor-js/execution@1.5.21
  - @executor-js/plugin-graphql@1.5.21
  - @executor-js/plugin-mcp@1.5.21
  - @executor-js/api@1.4.41
  - @executor-js/vite-plugin@0.0.38
  - @executor-js/cloudflare@0.0.20
  - @executor-js/host-mcp@1.4.4
  - @executor-js/plugin-toolkits@1.5.13
  - @executor-js/plugin-workos-vault@0.0.2
  - @executor-js/react@1.4.41

## 1.4.38

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.20
  - @executor-js/runtime-quickjs@1.5.20
  - @executor-js/execution@1.5.20
  - @executor-js/plugin-graphql@1.5.20
  - @executor-js/plugin-mcp@1.5.20
  - @executor-js/plugin-openapi@1.5.20
  - @executor-js/api@1.4.40
  - @executor-js/vite-plugin@0.0.37
  - @executor-js/cloudflare@0.0.19
  - @executor-js/host-mcp@1.4.4
  - @executor-js/runtime-dynamic-worker@1.4.4
  - @executor-js/plugin-google@1.5.19
  - @executor-js/plugin-microsoft@1.5.19
  - @executor-js/plugin-workos-vault@0.0.2
  - @executor-js/react@1.4.40

## 1.4.37

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.19
  - @executor-js/runtime-quickjs@1.5.19
  - @executor-js/execution@1.5.19
  - @executor-js/plugin-graphql@1.5.19
  - @executor-js/plugin-mcp@1.5.19
  - @executor-js/plugin-openapi@1.5.19
  - @executor-js/api@1.4.39
  - @executor-js/vite-plugin@0.0.36
  - @executor-js/cloudflare@0.0.18
  - @executor-js/host-mcp@1.4.4
  - @executor-js/runtime-dynamic-worker@1.4.4
  - @executor-js/plugin-google@1.5.18
  - @executor-js/plugin-microsoft@1.5.18
  - @executor-js/plugin-workos-vault@0.0.2
  - @executor-js/react@1.4.39

## 1.4.36

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.18
  - @executor-js/runtime-quickjs@1.5.18
  - @executor-js/execution@1.5.18
  - @executor-js/plugin-graphql@1.5.18
  - @executor-js/plugin-mcp@1.5.18
  - @executor-js/plugin-openapi@1.5.18
  - @executor-js/api@1.4.38
  - @executor-js/vite-plugin@0.0.35
  - @executor-js/cloudflare@0.0.17
  - @executor-js/host-mcp@1.4.4
  - @executor-js/runtime-dynamic-worker@1.4.4
  - @executor-js/plugin-google@1.5.17
  - @executor-js/plugin-microsoft@1.5.17
  - @executor-js/plugin-workos-vault@0.0.2
  - @executor-js/react@1.4.38

## 1.4.35

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.17
  - @executor-js/runtime-quickjs@1.5.17
  - @executor-js/execution@1.5.17
  - @executor-js/plugin-graphql@1.5.17
  - @executor-js/plugin-mcp@1.5.17
  - @executor-js/plugin-openapi@1.5.17
  - @executor-js/api@1.4.37
  - @executor-js/vite-plugin@0.0.34
  - @executor-js/cloudflare@0.0.16
  - @executor-js/host-mcp@1.4.4
  - @executor-js/runtime-dynamic-worker@1.4.4
  - @executor-js/plugin-google@1.5.16
  - @executor-js/plugin-microsoft@1.5.16
  - @executor-js/plugin-workos-vault@0.0.2
  - @executor-js/react@1.4.37

## 1.4.34

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.16
  - @executor-js/runtime-quickjs@1.5.16
  - @executor-js/execution@1.5.16
  - @executor-js/plugin-graphql@1.5.16
  - @executor-js/plugin-mcp@1.5.16
  - @executor-js/plugin-openapi@1.5.16
  - @executor-js/api@1.4.36
  - @executor-js/vite-plugin@0.0.33
  - @executor-js/cloudflare@0.0.15
  - @executor-js/host-mcp@1.4.4
  - @executor-js/runtime-dynamic-worker@1.4.4
  - @executor-js/plugin-google@1.5.15
  - @executor-js/plugin-microsoft@1.5.15
  - @executor-js/plugin-workos-vault@0.0.2
  - @executor-js/react@1.4.36

## 1.4.33

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.15
  - @executor-js/plugin-openapi@1.5.15
  - @executor-js/plugin-mcp@1.5.15
  - @executor-js/api@1.4.35
  - @executor-js/execution@1.5.15
  - @executor-js/vite-plugin@0.0.32
  - @executor-js/cloudflare@0.0.14
  - @executor-js/host-mcp@1.4.4
  - @executor-js/runtime-dynamic-worker@1.4.4
  - @executor-js/plugin-graphql@1.5.15
  - @executor-js/plugin-workos-vault@0.0.2
  - @executor-js/react@1.4.35
  - @executor-js/runtime-quickjs@1.5.15

## 1.4.32

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.14
  - @executor-js/runtime-quickjs@1.5.14
  - @executor-js/execution@1.5.14
  - @executor-js/plugin-graphql@1.5.14
  - @executor-js/plugin-mcp@1.5.14
  - @executor-js/plugin-openapi@1.5.14
  - @executor-js/api@1.4.34
  - @executor-js/vite-plugin@0.0.31
  - @executor-js/cloudflare@0.0.13
  - @executor-js/host-mcp@1.4.4
  - @executor-js/runtime-dynamic-worker@1.4.4
  - @executor-js/plugin-workos-vault@0.0.2
  - @executor-js/react@1.4.34

## 1.4.31

### Patch Changes

- Updated dependencies [[`8244fee`](https://github.com/RhysSullivan/executor/commit/8244fee567cb2408650fc1fcd1a9e72cedc2f683)]:
  - @executor-js/execution@1.5.13
  - @executor-js/api@1.4.33
  - @executor-js/cloudflare@0.0.12
  - @executor-js/host-mcp@1.4.4
  - @executor-js/runtime-dynamic-worker@1.4.4
  - @executor-js/plugin-graphql@1.5.13
  - @executor-js/plugin-mcp@1.5.13
  - @executor-js/plugin-openapi@1.5.13
  - @executor-js/react@1.4.33
  - @executor-js/plugin-workos-vault@0.0.2
  - @executor-js/sdk@1.5.13
  - @executor-js/runtime-quickjs@1.5.13
  - @executor-js/vite-plugin@0.0.30

## 1.4.30

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.12
  - @executor-js/runtime-quickjs@1.5.12
  - @executor-js/execution@1.5.12
  - @executor-js/plugin-graphql@1.5.12
  - @executor-js/plugin-mcp@1.5.12
  - @executor-js/plugin-openapi@1.5.12
  - @executor-js/api@1.4.32
  - @executor-js/vite-plugin@0.0.29
  - @executor-js/cloudflare@0.0.11
  - @executor-js/host-mcp@1.4.4
  - @executor-js/runtime-dynamic-worker@1.4.4
  - @executor-js/plugin-workos-vault@0.0.2
  - @executor-js/react@1.4.32

## 1.4.29

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.11
  - @executor-js/runtime-quickjs@1.5.11
  - @executor-js/execution@1.5.11
  - @executor-js/plugin-graphql@1.5.11
  - @executor-js/plugin-mcp@1.5.11
  - @executor-js/plugin-openapi@1.5.11
  - @executor-js/api@1.4.31
  - @executor-js/vite-plugin@0.0.28
  - @executor-js/cloudflare@0.0.10
  - @executor-js/host-mcp@1.4.4
  - @executor-js/runtime-dynamic-worker@1.4.4
  - @executor-js/plugin-workos-vault@0.0.2
  - @executor-js/react@1.4.31

## 1.4.28

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.10
  - @executor-js/runtime-quickjs@1.5.10
  - @executor-js/execution@1.5.10
  - @executor-js/plugin-graphql@1.5.10
  - @executor-js/plugin-mcp@1.5.10
  - @executor-js/plugin-openapi@1.5.10
  - @executor-js/api@1.4.30
  - @executor-js/vite-plugin@0.0.27
  - @executor-js/cloudflare@0.0.9
  - @executor-js/host-mcp@1.4.4
  - @executor-js/runtime-dynamic-worker@1.4.4
  - @executor-js/plugin-workos-vault@0.0.2
  - @executor-js/react@1.4.30

## 1.4.27

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.9
  - @executor-js/runtime-quickjs@1.5.9
  - @executor-js/execution@1.5.9
  - @executor-js/plugin-graphql@1.5.9
  - @executor-js/plugin-mcp@1.5.9
  - @executor-js/plugin-openapi@1.5.9
  - @executor-js/api@1.4.29
  - @executor-js/vite-plugin@0.0.26
  - @executor-js/cloudflare@0.0.8
  - @executor-js/host-mcp@1.4.4
  - @executor-js/runtime-dynamic-worker@1.4.4
  - @executor-js/plugin-workos-vault@0.0.2
  - @executor-js/react@1.4.29

## 1.4.26

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.8
  - @executor-js/runtime-quickjs@1.5.8
  - @executor-js/execution@1.5.8
  - @executor-js/plugin-graphql@1.5.8
  - @executor-js/plugin-mcp@1.5.8
  - @executor-js/plugin-openapi@1.5.8
  - @executor-js/api@1.4.28
  - @executor-js/vite-plugin@0.0.25
  - @executor-js/cloudflare@0.0.7
  - @executor-js/host-mcp@1.4.4
  - @executor-js/runtime-dynamic-worker@1.4.4
  - @executor-js/plugin-workos-vault@0.0.2
  - @executor-js/react@1.4.28

## 1.4.25

### Patch Changes

- Updated dependencies [[`7cee242`](https://github.com/RhysSullivan/executor/commit/7cee242f07687b0d8711201c620d8c61594adc15), [`7cee242`](https://github.com/RhysSullivan/executor/commit/7cee242f07687b0d8711201c620d8c61594adc15)]:
  - @executor-js/sdk@1.5.7
  - @executor-js/plugin-openapi@1.5.7
  - @executor-js/plugin-graphql@1.5.7
  - @executor-js/fumadb@1.5.7
  - @executor-js/api@1.4.27
  - @executor-js/execution@1.5.7
  - @executor-js/vite-plugin@0.0.24
  - @executor-js/cloudflare@0.0.6
  - @executor-js/host-mcp@1.4.4
  - @executor-js/runtime-dynamic-worker@1.4.4
  - @executor-js/plugin-mcp@1.5.7
  - @executor-js/plugin-workos-vault@0.0.2
  - @executor-js/react@1.4.27
  - @executor-js/runtime-quickjs@1.5.7

## 1.4.24

### Patch Changes

- Updated dependencies [[`f485e4a`](https://github.com/RhysSullivan/executor/commit/f485e4a23cf3756b9e628cf2d9242fbc0b3da178)]:
  - @executor-js/react@1.4.26
  - @executor-js/plugin-graphql@1.5.4
  - @executor-js/plugin-mcp@1.5.4
  - @executor-js/plugin-openapi@1.5.4
  - @executor-js/plugin-workos-vault@0.0.2
  - @executor-js/runtime-dynamic-worker@1.4.4
  - @executor-js/sdk@1.5.4
  - @executor-js/runtime-quickjs@1.5.4
  - @executor-js/execution@1.5.4
  - @executor-js/api@1.4.26
  - @executor-js/vite-plugin@0.0.23
  - @executor-js/host-mcp@1.4.4
  - @executor-js/cloudflare@0.0.5

## 1.4.23

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.3
  - @executor-js/runtime-quickjs@1.5.3
  - @executor-js/execution@1.5.3
  - @executor-js/plugin-graphql@1.5.3
  - @executor-js/plugin-mcp@1.5.3
  - @executor-js/plugin-openapi@1.5.3
  - @executor-js/api@1.4.25
  - @executor-js/vite-plugin@0.0.22
  - @executor-js/host-mcp@1.4.4
  - @executor-js/runtime-dynamic-worker@1.4.4
  - @executor-js/plugin-workos-vault@0.0.2
  - @executor-js/react@1.4.25
  - @executor-js/cloudflare@0.0.4

## 1.4.22

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.2
  - @executor-js/runtime-quickjs@1.5.2
  - @executor-js/execution@1.5.2
  - @executor-js/plugin-graphql@1.5.2
  - @executor-js/plugin-mcp@1.5.2
  - @executor-js/plugin-openapi@1.5.2
  - @executor-js/api@1.4.24
  - @executor-js/vite-plugin@0.0.21
  - @executor-js/host-mcp@1.4.4
  - @executor-js/runtime-dynamic-worker@1.4.4
  - @executor-js/plugin-workos-vault@0.0.2
  - @executor-js/react@1.4.24
  - @executor-js/cloudflare@0.0.3

## 1.4.21

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.1
  - @executor-js/runtime-quickjs@1.5.1
  - @executor-js/execution@1.5.1
  - @executor-js/plugin-graphql@1.5.1
  - @executor-js/plugin-mcp@1.5.1
  - @executor-js/plugin-openapi@1.5.1
  - @executor-js/api@1.4.23
  - @executor-js/vite-plugin@0.0.20
  - @executor-js/host-mcp@1.4.4
  - @executor-js/runtime-dynamic-worker@1.4.4
  - @executor-js/plugin-workos-vault@0.0.2
  - @executor-js/react@1.4.23
  - @executor-js/cloudflare@0.0.2

## 1.4.20

### Patch Changes

- Updated dependencies [[`7d7fbbd`](https://github.com/RhysSullivan/executor/commit/7d7fbbda9c0912e70334dcc809ec755ba3328f68), [`1ba0193`](https://github.com/RhysSullivan/executor/commit/1ba01932919e6aee25a76c4c093841df8539adad), [`9c9bcb6`](https://github.com/RhysSullivan/executor/commit/9c9bcb663e48ebb21a71f8058812319c1ec2a242)]:
  - @executor-js/sdk@1.5.0
  - @executor-js/plugin-openapi@1.5.0
  - @executor-js/execution@1.5.0
  - @executor-js/plugin-graphql@1.5.0
  - @executor-js/plugin-mcp@1.5.0
  - @executor-js/runtime-quickjs@1.5.0
  - @executor-js/api@1.4.22
  - @executor-js/vite-plugin@0.0.19
  - @executor-js/host-mcp@1.4.4
  - @executor-js/runtime-dynamic-worker@1.4.4
  - @executor-js/plugin-workos-vault@0.0.2
  - @executor-js/react@1.4.22
  - @executor-js/cloudflare@0.0.1
