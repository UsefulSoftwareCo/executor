# @executor-js/execution

## 1.6.2

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.6.2
  - @executor-js/codemode-core@1.6.2

## 1.6.1

### Patch Changes

- [#1741](https://github.com/UsefulSoftwareCo/executor/pull/1741) [`62748e8`](https://github.com/UsefulSoftwareCo/executor/commit/62748e86122b747226c76c2e112c5c4d2b4f7095) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - **Opt-in per-integration search tools on the MCP surface**

  Connecting with `?search_tools=true` (stdio: `executor mcp --search-tools`) adds one minimally-described `search_<integration>` MCP tool per connected integration, so the integration namespaces reach the model as tool names it can see without calling anything. Each call routes through the same flow as `tools.search({ namespace })` inside `execute`, and the tool list comes from the same inventory the `execute` description shows. Off by default; a clean endpoint URL is unchanged.

- [#1749](https://github.com/UsefulSoftwareCo/executor/pull/1749) [`d4afe0c`](https://github.com/UsefulSoftwareCo/executor/commit/d4afe0c79f146dd169a00988a2d5d0469297be19) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - Slim the per-integration `search_<integration>` tool definitions to under half their size: one shared one-line description (the tool name already carries the namespace) and a single bare `query` parameter, dropping the `limit`/`offset` knobs. A session pays for these definitions once per connected integration, so the surface now costs ~2k tokens instead of ~5k at 30 integrations; paging through a namespace belongs in `execute`.

- Updated dependencies [[`55180cb`](https://github.com/UsefulSoftwareCo/executor/commit/55180cb1487f9a3a28ddc0ee0bedfab8464c1f72)]:
  - @executor-js/sdk@1.6.1
  - @executor-js/codemode-core@1.6.1

## 1.6.0

### Patch Changes

- Updated dependencies [[`a2d1417`](https://github.com/UsefulSoftwareCo/executor/commit/a2d141758e478274813c8c24d354e1fd0f66af49)]:
  - @executor-js/sdk@1.6.0
  - @executor-js/codemode-core@1.6.0

## 1.5.42

### Patch Changes

- Updated dependencies [[`d3f0617`](https://github.com/UsefulSoftwareCo/executor/commit/d3f0617deec06c57e0d6e1479fe668f79daf977d)]:
  - @executor-js/sdk@1.5.42
  - @executor-js/codemode-core@1.5.42

## 1.5.41

### Patch Changes

- Updated dependencies [[`d572658`](https://github.com/UsefulSoftwareCo/executor/commit/d572658d74097917412256f10a3ea2e3974f44dd)]:
  - @executor-js/sdk@1.5.41
  - @executor-js/codemode-core@1.5.41

## 1.5.40

### Patch Changes

- Updated dependencies [[`8ba64f6`](https://github.com/UsefulSoftwareCo/executor/commit/8ba64f675f6d6ab5302d4f68390c0b055d006f4a)]:
  - @executor-js/sdk@1.5.40
  - @executor-js/codemode-core@1.5.40

## 1.5.39

### Patch Changes

- Updated dependencies [[`6c316c7`](https://github.com/UsefulSoftwareCo/executor/commit/6c316c77a9efc98784976236852b58c6156e016e)]:
  - @executor-js/sdk@1.5.39
  - @executor-js/codemode-core@1.5.39

## 1.5.38

### Patch Changes

- Updated dependencies [[`6a924dd`](https://github.com/UsefulSoftwareCo/executor/commit/6a924dd98de916d6ff8cea2329bf672f149b64f4)]:
  - @executor-js/sdk@1.5.38
  - @executor-js/codemode-core@1.5.38

## 1.5.37

### Patch Changes

- Updated dependencies [[`657b913`](https://github.com/UsefulSoftwareCo/executor/commit/657b9135b8b841495b362936bf60bdca998c16eb)]:
  - @executor-js/sdk@1.5.37
  - @executor-js/codemode-core@1.5.37

## 1.5.36

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.36
  - @executor-js/codemode-core@1.5.36

## 1.5.35

### Patch Changes

- Updated dependencies [[`1b9b1f1`](https://github.com/UsefulSoftwareCo/executor/commit/1b9b1f10313834a625a411169ebf83f6181589df)]:
  - @executor-js/sdk@1.5.35
  - @executor-js/codemode-core@1.5.35

## 1.5.34

### Patch Changes

- [#1422](https://github.com/UsefulSoftwareCo/executor/pull/1422) [`e2712db`](https://github.com/UsefulSoftwareCo/executor/commit/e2712dbff98145c5c340832ffbdcb21113b9dd78) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - A token refresh the authorization server definitively rejects (any RFC 6749 error code, not just `invalid_grant`) now surfaces to the sandbox as an `oauth_refresh_failed` auth failure carrying the server's error code and description, instead of being scrubbed to "Internal tool error". `invalid_grant` still classifies as `oauth_reauth_required`. Code-less failures (transport blips) keep retrying as before.

- Updated dependencies [[`e2712db`](https://github.com/UsefulSoftwareCo/executor/commit/e2712dbff98145c5c340832ffbdcb21113b9dd78), [`7207347`](https://github.com/UsefulSoftwareCo/executor/commit/720734756a70b1b4f1564bdf82dc4118e5de2b76), [`0c4e9b4`](https://github.com/UsefulSoftwareCo/executor/commit/0c4e9b49fecb35ad71c92a464c3ea01131ff9d6f)]:
  - @executor-js/sdk@1.5.34
  - @executor-js/codemode-core@1.5.34

## 1.5.33

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.33
  - @executor-js/codemode-core@1.5.33

## 1.5.32

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.32
  - @executor-js/codemode-core@1.5.32

## 1.5.31

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.31
  - @executor-js/codemode-core@1.5.31

## 1.5.30

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.30
  - @executor-js/codemode-core@1.5.30

## 1.5.29

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.29
  - @executor-js/codemode-core@1.5.29

## 1.5.28

### Patch Changes

- Updated dependencies [[`1c48182`](https://github.com/UsefulSoftwareCo/executor/commit/1c4818254e71dc4ee27ff95f489e2c5cf330a450)]:
  - @executor-js/sdk@1.5.28
  - @executor-js/codemode-core@1.5.28

## 1.5.27

### Patch Changes

- Add a `skills` tool and slim the always-loaded `execute` description. The execute tool's calling-convention guide now lives behind `skills({ name: "execute" })`, so a session loads it on demand instead of carrying it up front. The `execute` description keeps a one-line intro, a pointer to the skill, and a names-only list of the integrations the user has connected (deduped across connections, no per-connection prefixes).

- Updated dependencies []:
  - @executor-js/sdk@1.5.27
  - @executor-js/codemode-core@1.5.27

## 1.5.26

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.26
  - @executor-js/codemode-core@1.5.26

## 1.5.25

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.25
  - @executor-js/codemode-core@1.5.25

## 1.5.24

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.24
  - @executor-js/codemode-core@1.5.24

## 1.5.23

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.23
  - @executor-js/codemode-core@1.5.23

## 1.5.22

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.22
  - @executor-js/codemode-core@1.5.22

## 1.5.21

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.21
  - @executor-js/codemode-core@1.5.21

## 1.5.20

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.20
  - @executor-js/codemode-core@1.5.20

## 1.5.19

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.19
  - @executor-js/codemode-core@1.5.19

## 1.5.18

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.18
  - @executor-js/codemode-core@1.5.18

## 1.5.17

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.17
  - @executor-js/codemode-core@1.5.17

## 1.5.16

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.16
  - @executor-js/codemode-core@1.5.16

## 1.5.15

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.15
  - @executor-js/codemode-core@1.5.15

## 1.5.14

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.14
  - @executor-js/codemode-core@1.5.14

## 1.5.13

### Patch Changes

- [#976](https://github.com/RhysSullivan/executor/pull/976) [`8244fee`](https://github.com/RhysSullivan/executor/commit/8244fee567cb2408650fc1fcd1a9e72cedc2f683) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - Make paused-execution resume reliable: `resume` is now idempotent (a retried
  resume replays the recorded outcome instead of failing with "No paused
  execution"), execution ids are globally unique so a rebuilt engine can never
  re-mint an id a stale client still holds, pauses abandoned by a dead sandbox
  are dropped and their terminal outcome kept for late resumes, and an expired
  or lost pause now returns recovery guidance (re-run execute) instead of a bare
  miss.
- Updated dependencies []:
  - @executor-js/sdk@1.5.13
  - @executor-js/codemode-core@1.5.13

## 1.5.12

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.12
  - @executor-js/codemode-core@1.5.12

## 1.5.11

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.11
  - @executor-js/codemode-core@1.5.11

## 1.5.10

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.10
  - @executor-js/codemode-core@1.5.10

## 1.5.9

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.9
  - @executor-js/codemode-core@1.5.9

## 1.5.8

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.8
  - @executor-js/codemode-core@1.5.8

## 1.5.7

### Patch Changes

- Updated dependencies [[`7cee242`](https://github.com/RhysSullivan/executor/commit/7cee242f07687b0d8711201c620d8c61594adc15), [`7cee242`](https://github.com/RhysSullivan/executor/commit/7cee242f07687b0d8711201c620d8c61594adc15)]:
  - @executor-js/sdk@1.5.7
  - @executor-js/codemode-core@1.5.7

## 1.5.4

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.4
  - @executor-js/codemode-core@1.5.4

## 1.5.3

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.3
  - @executor-js/codemode-core@1.5.3

## 1.5.2

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.2
  - @executor-js/codemode-core@1.5.2

## 1.5.1

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.1
  - @executor-js/codemode-core@1.5.1

## 1.5.0

### Patch Changes

- [#922](https://github.com/RhysSullivan/executor/pull/922) [`1ba0193`](https://github.com/RhysSullivan/executor/commit/1ba01932919e6aee25a76c4c093841df8539adad) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - Move `effect` from `dependencies` to `peerDependencies` in the published library packages so consumers provide a single shared Effect instance.

- Updated dependencies [[`7d7fbbd`](https://github.com/RhysSullivan/executor/commit/7d7fbbda9c0912e70334dcc809ec755ba3328f68), [`1ba0193`](https://github.com/RhysSullivan/executor/commit/1ba01932919e6aee25a76c4c093841df8539adad)]:
  - @executor-js/sdk@1.5.0
  - @executor-js/codemode-core@1.5.0
