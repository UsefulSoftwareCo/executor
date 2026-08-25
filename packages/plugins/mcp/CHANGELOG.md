# @executor-js/plugin-mcp

## 1.5.42

### Patch Changes

- [#1646](https://github.com/UsefulSoftwareCo/executor/pull/1646) [`9ecc7cb`](https://github.com/UsefulSoftwareCo/executor/commit/9ecc7cb8b30375ffa960e3fefe4d211e0254e691) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - **Stdio MCP servers can negotiate the modern protocol (`versionNegotiation: "auto"`)**

  Spawned stdio MCP integrations previously always opened with the legacy 2025 `initialize` handshake, so an SDK v2 server running with its legacy compatibility lane disabled could not connect. Stdio integrations now accept `versionNegotiation: "auto"` (on `mcp.addServer` and the stored config) to probe `server/discover` per spec 2026-07-28, falling back to `initialize` on legacy servers. The default stays `legacy`: the SDK's stdio probe costs an extra short-lived child process per connect and stalls on silent legacy servers, which is the wrong trade for spawn-per-call CLI servers. The connect handshake span now records the negotiated era (`plugin.mcp.protocol_era`) so integration authors can verify which handshake a connection used.

- Updated dependencies [[`d3f0617`](https://github.com/UsefulSoftwareCo/executor/commit/d3f0617deec06c57e0d6e1479fe668f79daf977d)]:
  - @executor-js/sdk@1.5.42
  - @executor-js/api@1.4.62
  - @executor-js/config@1.5.42
  - @executor-js/react@1.4.62

## 1.5.41

### Patch Changes

- [#1617](https://github.com/UsefulSoftwareCo/executor/pull/1617) [`a9b33d2`](https://github.com/UsefulSoftwareCo/executor/commit/a9b33d25c32fbb4a292b7e8963e22392f862a16f) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - Support MCP spec 2026-07-28 end to end. The MCP client negotiates the protocol era automatically (`server/discover` probe with legacy fallback), so integrations hosted on modern-only MCP servers connect without the server enabling legacy compatibility. Executor-hosted MCP endpoints serve both eras, and the `executor mcp` stdio bridge passes either era through to the daemon.

- Updated dependencies [[`d572658`](https://github.com/UsefulSoftwareCo/executor/commit/d572658d74097917412256f10a3ea2e3974f44dd)]:
  - @executor-js/sdk@1.5.41
  - @executor-js/api@1.4.61
  - @executor-js/config@1.5.41
  - @executor-js/react@1.4.61

## 1.5.40

### Patch Changes

- Updated dependencies [[`8ba64f6`](https://github.com/UsefulSoftwareCo/executor/commit/8ba64f675f6d6ab5302d4f68390c0b055d006f4a)]:
  - @executor-js/sdk@1.5.40
  - @executor-js/api@1.4.60
  - @executor-js/config@1.5.40
  - @executor-js/react@1.4.60

## 1.5.39

### Patch Changes

- Updated dependencies [[`6c316c7`](https://github.com/UsefulSoftwareCo/executor/commit/6c316c77a9efc98784976236852b58c6156e016e)]:
  - @executor-js/sdk@1.5.39
  - @executor-js/api@1.4.59
  - @executor-js/config@1.5.39
  - @executor-js/react@1.4.59

## 1.5.38

### Patch Changes

- Updated dependencies [[`6a924dd`](https://github.com/UsefulSoftwareCo/executor/commit/6a924dd98de916d6ff8cea2329bf672f149b64f4), [`1de85fc`](https://github.com/UsefulSoftwareCo/executor/commit/1de85fc0201c0c23c0e71e003c49228d406af6c8)]:
  - @executor-js/sdk@1.5.38
  - @executor-js/react@1.4.58
  - @executor-js/api@1.4.58
  - @executor-js/config@1.5.38

## 1.5.37

### Patch Changes

- Updated dependencies [[`657b913`](https://github.com/UsefulSoftwareCo/executor/commit/657b9135b8b841495b362936bf60bdca998c16eb)]:
  - @executor-js/sdk@1.5.37
  - @executor-js/api@1.4.57
  - @executor-js/config@1.5.37
  - @executor-js/react@1.4.57

## 1.5.36

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.36
  - @executor-js/config@1.5.36
  - @executor-js/api@1.4.56
  - @executor-js/react@1.4.56

## 1.5.35

### Patch Changes

- [#1435](https://github.com/UsefulSoftwareCo/executor/pull/1435) [`af95edb`](https://github.com/UsefulSoftwareCo/executor/commit/af95edbb0bbde544bb1f4c6e18e9d64a2bcab0f8) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - Reuse downstream MCP sessions across tool calls. Remote MCP invocations now lease connections from a per-plugin-instance pool (one idle session per resolved credential identity, exclusive per invoke, 5-minute idle TTL) instead of dialing a fresh connection per call, so servers that key state by `Mcp-Session-Id` (workspace selection and similar) see consecutive calls in the same session. A reused session rejected with HTTP 404 is redialed once transparently; stdio transports and endpoint probing remain per-call.

- Updated dependencies [[`1b9b1f1`](https://github.com/UsefulSoftwareCo/executor/commit/1b9b1f10313834a625a411169ebf83f6181589df)]:
  - @executor-js/sdk@1.5.35
  - @executor-js/api@1.4.55
  - @executor-js/config@1.5.35
  - @executor-js/react@1.4.55

## 1.5.34

### Patch Changes

- Updated dependencies [[`e2712db`](https://github.com/UsefulSoftwareCo/executor/commit/e2712dbff98145c5c340832ffbdcb21113b9dd78), [`7207347`](https://github.com/UsefulSoftwareCo/executor/commit/720734756a70b1b4f1564bdf82dc4118e5de2b76), [`0c4e9b4`](https://github.com/UsefulSoftwareCo/executor/commit/0c4e9b49fecb35ad71c92a464c3ea01131ff9d6f)]:
  - @executor-js/sdk@1.5.34
  - @executor-js/api@1.4.54
  - @executor-js/config@1.5.34
  - @executor-js/react@1.4.54

## 1.5.33

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.33
  - @executor-js/config@1.5.33
  - @executor-js/api@1.4.53
  - @executor-js/react@1.4.53

## 1.5.32

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.32
  - @executor-js/config@1.5.32
  - @executor-js/api@1.4.52
  - @executor-js/react@1.4.52

## 1.5.31

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.31
  - @executor-js/config@1.5.31
  - @executor-js/api@1.4.51
  - @executor-js/react@1.4.51

## 1.5.30

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.30
  - @executor-js/config@1.5.30
  - @executor-js/api@1.4.50
  - @executor-js/react@1.4.50

## 1.5.29

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.29
  - @executor-js/config@1.5.29
  - @executor-js/api@1.4.49
  - @executor-js/react@1.4.49

## 1.5.28

### Patch Changes

- [#1246](https://github.com/UsefulSoftwareCo/executor/pull/1246) [`1c48182`](https://github.com/UsefulSoftwareCo/executor/commit/1c4818254e71dc4ee27ff95f489e2c5cf330a450) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - Keep MCP tool catalogs in sync with the server's live tool set. Previously a
  connection's tools were listed once at create time and never updated unless the
  integration's config changed or a user clicked Refresh, so server-side tool
  changes silently broke invocations.
  - `tools/list` discovery now follows `nextCursor` pagination per the MCP spec,
    so servers with paginated catalogs list completely instead of first-page-only.
  - The client handles `notifications/tools/list_changed` received during a tool
    call and marks the connection's persisted catalog stale; the next tools read
    re-lists from the server.
  - An unknown-tool rejection from the server (protocol error or the reference
    SDK's error envelope) returns a typed `mcp_tool_unknown` failure telling the
    caller to re-list, and marks the catalog stale so it heals on the next read.
  - Remote catalogs now also refresh on read once older than a freshness TTL
    (`ExecutorConfig.toolsSyncTtlMs`, default 15 minutes, `null` to disable),
    covering servers that change tools without notifying.
  - A failed listing (server unreachable, auth not ready) no longer wipes the
    previously persisted catalog; it is kept and retried after the TTL.

- Updated dependencies [[`1c48182`](https://github.com/UsefulSoftwareCo/executor/commit/1c4818254e71dc4ee27ff95f489e2c5cf330a450)]:
  - @executor-js/sdk@1.5.28
  - @executor-js/api@1.4.48
  - @executor-js/config@1.5.28
  - @executor-js/react@1.4.48

## 1.5.27

### Patch Changes

- Updated dependencies [[`c7ab1e2`](https://github.com/RhysSullivan/executor/commit/c7ab1e2d56884e0453af85f6399fd25a39f04785)]:
  - @executor-js/api@1.4.47
  - @executor-js/react@1.4.47
  - @executor-js/sdk@1.5.27
  - @executor-js/config@1.5.27

## 1.5.26

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.26
  - @executor-js/config@1.5.26
  - @executor-js/api@1.4.46
  - @executor-js/react@1.4.46

## 1.5.25

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.25
  - @executor-js/config@1.5.25
  - @executor-js/api@1.4.45
  - @executor-js/react@1.4.45

## 1.5.24

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.24
  - @executor-js/config@1.5.24
  - @executor-js/api@1.4.44
  - @executor-js/react@1.4.44

## 1.5.23

### Patch Changes

- Updated dependencies [[`29936d5`](https://github.com/RhysSullivan/executor/commit/29936d5981256f8f953797d9ce8ce073ac6a0b6a), [`29936d5`](https://github.com/RhysSullivan/executor/commit/29936d5981256f8f953797d9ce8ce073ac6a0b6a)]:
  - @executor-js/api@1.4.43
  - @executor-js/react@1.4.43
  - @executor-js/sdk@1.5.23
  - @executor-js/config@1.5.23

## 1.5.22

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.22
  - @executor-js/config@1.5.22
  - @executor-js/api@1.4.42
  - @executor-js/react@1.4.42

## 1.5.21

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.21
  - @executor-js/config@1.5.21
  - @executor-js/api@1.4.41
  - @executor-js/react@1.4.41

## 1.5.20

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.20
  - @executor-js/config@1.5.20
  - @executor-js/api@1.4.40
  - @executor-js/react@1.4.40

## 1.5.19

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.19
  - @executor-js/config@1.5.19
  - @executor-js/api@1.4.39
  - @executor-js/react@1.4.39

## 1.5.18

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.18
  - @executor-js/config@1.5.18
  - @executor-js/api@1.4.38
  - @executor-js/react@1.4.38

## 1.5.17

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.17
  - @executor-js/config@1.5.17
  - @executor-js/api@1.4.37
  - @executor-js/react@1.4.37

## 1.5.16

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.16
  - @executor-js/config@1.5.16
  - @executor-js/api@1.4.36
  - @executor-js/react@1.4.36

## 1.5.15

### Patch Changes

- Surface binary tool results as model-native file outputs across OpenAPI and upstream MCP integrations.

- Updated dependencies []:
  - @executor-js/sdk@1.5.15
  - @executor-js/api@1.4.35
  - @executor-js/config@1.5.15
  - @executor-js/react@1.4.35

## 1.5.14

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.14
  - @executor-js/config@1.5.14
  - @executor-js/api@1.4.34
  - @executor-js/react@1.4.34

## 1.5.13

### Patch Changes

- Updated dependencies []:
  - @executor-js/api@1.4.33
  - @executor-js/react@1.4.33
  - @executor-js/sdk@1.5.13
  - @executor-js/config@1.5.13

## 1.5.12

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.12
  - @executor-js/config@1.5.12
  - @executor-js/api@1.4.32
  - @executor-js/react@1.4.32

## 1.5.11

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.11
  - @executor-js/config@1.5.11
  - @executor-js/api@1.4.31
  - @executor-js/react@1.4.31

## 1.5.10

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.10
  - @executor-js/config@1.5.10
  - @executor-js/api@1.4.30
  - @executor-js/react@1.4.30

## 1.5.9

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.9
  - @executor-js/config@1.5.9
  - @executor-js/api@1.4.29
  - @executor-js/react@1.4.29

## 1.5.8

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.8
  - @executor-js/config@1.5.8
  - @executor-js/api@1.4.28
  - @executor-js/react@1.4.28

## 1.5.7

### Patch Changes

- Updated dependencies [[`7cee242`](https://github.com/RhysSullivan/executor/commit/7cee242f07687b0d8711201c620d8c61594adc15), [`7cee242`](https://github.com/RhysSullivan/executor/commit/7cee242f07687b0d8711201c620d8c61594adc15)]:
  - @executor-js/sdk@1.5.7
  - @executor-js/api@1.4.27
  - @executor-js/config@1.5.7
  - @executor-js/react@1.4.27

## 1.5.4

### Patch Changes

- Updated dependencies [[`f485e4a`](https://github.com/RhysSullivan/executor/commit/f485e4a23cf3756b9e628cf2d9242fbc0b3da178)]:
  - @executor-js/react@1.4.26
  - @executor-js/sdk@1.5.4
  - @executor-js/config@1.5.4
  - @executor-js/api@1.4.26

## 1.5.3

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.3
  - @executor-js/config@1.5.3
  - @executor-js/api@1.4.25
  - @executor-js/react@1.4.25

## 1.5.2

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.2
  - @executor-js/config@1.5.2
  - @executor-js/api@1.4.24
  - @executor-js/react@1.4.24

## 1.5.1

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.1
  - @executor-js/config@1.5.1
  - @executor-js/api@1.4.23
  - @executor-js/react@1.4.23

## 1.5.0

### Patch Changes

- [#922](https://github.com/RhysSullivan/executor/pull/922) [`1ba0193`](https://github.com/RhysSullivan/executor/commit/1ba01932919e6aee25a76c4c093841df8539adad) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - Move `effect` from `dependencies` to `peerDependencies` in the published library packages so consumers provide a single shared Effect instance.

- Updated dependencies [[`7d7fbbd`](https://github.com/RhysSullivan/executor/commit/7d7fbbda9c0912e70334dcc809ec755ba3328f68), [`1ba0193`](https://github.com/RhysSullivan/executor/commit/1ba01932919e6aee25a76c4c093841df8539adad)]:
  - @executor-js/sdk@1.5.0
  - @executor-js/config@1.5.0
  - @executor-js/api@1.4.22
  - @executor-js/react@1.4.22
