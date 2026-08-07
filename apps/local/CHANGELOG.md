# @executor-js/local

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
