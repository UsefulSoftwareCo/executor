# @executor-js/plugin-mcp

## 1.6.3

### Patch Changes

- [#1815](https://github.com/UsefulSoftwareCo/executor/pull/1815) [`4b0fbf6`](https://github.com/UsefulSoftwareCo/executor/commit/4b0fbf68550516af9235c9267f91a962da993946) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - **The add-MCP form stops dialling the server URL while it is still being typed**

  The Server URL field auto-probes the endpoint after a 400ms pause. The only condition on that probe was that the trimmed value was non-empty, so every pause in typing dialled whatever was in the field: "h", "http://", the "a" in "http://a". Each of those probes failed, and the field dropped into a loading state and then an error with a retry button, for a value the user never meant to submit.

  The probe now runs only when the value looks like a finished endpoint: it parses as a URL, its scheme is http or https, and its hostname is either a local development host or has a dot with a label on each side. The debounce is unchanged, so a completed URL is still probed without the user having to submit.

  A probe that is superseded is also no longer allowed to answer. The field could previously report the outcome of a request for a URL that had since been edited, because each probe dispatched its result unconditionally. Editing the URL now invalidates any probe already in flight, and its reply is discarded rather than applied to the current value.

- [#1702](https://github.com/UsefulSoftwareCo/executor/pull/1702) [`ba62f1a`](https://github.com/UsefulSoftwareCo/executor/commit/ba62f1a5d14b7002ba0a4686a9e1ae43bd77f54f) Thanks [@altaywtf](https://github.com/altaywtf)! - Allow MCP integrations to declare a catalog family and group any family with multiple services in the integrations UI.

- [#1595](https://github.com/UsefulSoftwareCo/executor/pull/1595) [`8324e1e`](https://github.com/UsefulSoftwareCo/executor/commit/8324e1eb8b03965050147309f049bdb52be6fcad) Thanks [@GeiserX](https://github.com/GeiserX)! - **Stdio MCP servers no longer inherit executor's full environment**

  A stdio MCP server that declared any `env` at all was spawned with every environment variable this process holds. The MCP SDK already guards against that: it spawns with `{ ...getDefaultEnvironment(), ...serverParams.env }`, where `getDefaultEnvironment()` is a sudo-style safe-list of `HOME`, `LOGNAME`, `PATH`, `SHELL`, `TERM` and `USER`. Passing `{ ...process.env, ...config.env }` did not add to that safe-list, it overwrote it. In practice, adding one third-party `npx` server went from "this server can see the API key I gave it" to "this server also holds `EXECUTOR_SECRET_KEY`, the key that decrypts every other stored credential, plus `EXECUTOR_AUTH_TOKEN` and `DATABASE_URL`". The leak sat on the `config.env` branch — the branch a credential-bearing integration takes.

  A stdio server now receives the SDK's safe-list, the variables declared on the source config, and one short allowlist of infrastructure variables read from the host: `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY` (both spellings), `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE` and `SSL_CERT_DIR`. Those carry no credential, no source config declares them, and a server behind a corporate proxy or an intercepting CA cannot reach anything without them — the same reasoning and the same list `service install` already uses when it bakes a supervised unit's minimal environment. The declared `env` wins on a key collision. On Windows that collision is resolved case-insensitively, because the OS treats `Path` and `PATH` as one variable while a JavaScript spread does not: a declared `http_proxy` now replaces an inherited `HTTP_PROXY` instead of travelling beside it, which would have left the child reading whichever spelling Windows resolved first.

  If a stdio server relied on some other variable arriving from the host, set it explicitly on the source's `env`. That is now the only way anything beyond the lists above reaches a server, and it is the mechanism that already existed for it.

- [#1813](https://github.com/UsefulSoftwareCo/executor/pull/1813) [`6305b6d`](https://github.com/UsefulSoftwareCo/executor/commit/6305b6d11505358fa73ec2b3e768ec4256c36435) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - **An MCP tool's reserved `_meta` map survives `tools/list` decoding and reaches the persisted catalog**

  The MCP spec reserves `_meta` on `Tool` for implementation-defined data, and servers use it for host-only routing and policy hints that do not belong in the closed `annotations` set. The plugin decoded each listed tool with a closed struct that did not declare the field, so `_meta` was discarded before the manifest entry was built. A host that embeds the plugin as its MCP client had no way to recover it: no hook exposes the raw `tools/list` result, and `connections.refresh()` answers with already-built tools.

  The listed-tool decode now declares `_meta`, and the manifest entry carries it through. Executor's own `Tool` has no `_meta` field, so `toToolDef` stamps the map into the `mcp` envelope the plugin already persists in each tool row's annotations, next to the real MCP tool name. The stamp schema declares it too, so it is not stripped a second time when a row is read back at invoke time. A host reads it from `annotations.mcp._meta`.

  The map stays opaque. Nothing in the plugin interprets its contents, and it is never merged into anything the model sees. Because it is entirely server-controlled, it is decoded permissively: a `_meta` that is not the spec's map shape is ignored for that tool rather than failing the whole-list decode, which would otherwise drop every tool the server advertises.

- Updated dependencies [[`66fb1a4`](https://github.com/UsefulSoftwareCo/executor/commit/66fb1a4154226d28691ca83bdf6f3daa417ef0ce), [`c1f51b7`](https://github.com/UsefulSoftwareCo/executor/commit/c1f51b7f96328b795669bb3d241667660dc2b060), [`d7e4b73`](https://github.com/UsefulSoftwareCo/executor/commit/d7e4b73a86b8e413af70e0fcb26f38a35a3f4546), [`02b52cd`](https://github.com/UsefulSoftwareCo/executor/commit/02b52cd01b09d3601ffe88d1f9c0b777f26e76ae)]:
  - @executor-js/react@1.4.66
  - @executor-js/sdk@1.6.3
  - @executor-js/api@1.4.66
  - @executor-js/config@1.6.3

## 1.6.2

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.6.2
  - @executor-js/config@1.6.2
  - @executor-js/api@1.4.65
  - @executor-js/react@1.4.65

## 1.6.1

### Patch Changes

- [#1747](https://github.com/UsefulSoftwareCo/executor/pull/1747) [`91062c2`](https://github.com/UsefulSoftwareCo/executor/commit/91062c2b1d7b8edbc8470ca5eaa544045652afaa) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - Load the MCP client SDK lazily on first outbound connection instead of at module evaluation. Runtimes that bundle the plugin (notably Cloudflare Workers) no longer pay the client package's module-eval memory and CPU on startup or on code paths that never dial an MCP server.

- [#1716](https://github.com/UsefulSoftwareCo/executor/pull/1716) [`9c35f26`](https://github.com/UsefulSoftwareCo/executor/commit/9c35f269dd5de3548111fe5c83cf1e877f23c80d) Thanks [@xav-ie](https://github.com/xav-ie)! - **Closing a remote MCP connection now ends its streamable-http SSE request**

  On a supplied `httpClientLayer`, the fetch adapter wired the caller's `AbortSignal` only to the pending response promise, never to the response body, so closing a connection left the long-lived `GET` channel in flight forever — one abandoned request per dial. Under Bun each holds one of the 256 concurrent-request slots, so a long-running process eventually exhausts the pool and every connection starts failing with `MCP discovery timed out after 15000ms`. The response stream is now interrupted when the signal aborts.

- Updated dependencies [[`9dff4e8`](https://github.com/UsefulSoftwareCo/executor/commit/9dff4e8e6598e7d3108634a71269245ba9b480bb), [`55180cb`](https://github.com/UsefulSoftwareCo/executor/commit/55180cb1487f9a3a28ddc0ee0bedfab8464c1f72)]:
  - @executor-js/react@1.4.64
  - @executor-js/sdk@1.6.1
  - @executor-js/api@1.4.64
  - @executor-js/config@1.6.1

## 1.6.0

### Minor Changes

- [#1733](https://github.com/UsefulSoftwareCo/executor/pull/1733) [`0b0b74f`](https://github.com/UsefulSoftwareCo/executor/commit/0b0b74f673b8098c5248159be36c648097f3c87b) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - Restore MCP spec 2026-07-28 negotiation for outbound MCP connections. Remote Streamable HTTP connections auto-negotiate the modern protocol era again, stdio servers can opt in per integration, and the negotiated era is recorded on connection handshake traces.

### Patch Changes

- [#1660](https://github.com/UsefulSoftwareCo/executor/pull/1660) [`c11bef2`](https://github.com/UsefulSoftwareCo/executor/commit/c11bef2cd049db7bbf51b15e18761b14acccb534) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - **Cloudflare ships as MCP-only, with code mode opted out**

  The Cloudflare OpenAPI preset is gone from the default catalog; the MCP preset is the one Cloudflare entry. Its endpoint now pins `?codemode=false` because Cloudflare's MCP server otherwise hides the tool catalog behind a single code-execution tool, and executor already provides the code-execution surface. Hand-entered `mcp.cloudflare.com` URLs missing the opt-out get an inline warning in the add flow telling the user to append `?codemode=false`.

- [#1654](https://github.com/UsefulSoftwareCo/executor/pull/1654) [`256e25e`](https://github.com/UsefulSoftwareCo/executor/commit/256e25e7b291b0c023bc7547d092004b66781bba) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - **Interrupted stdio dials no longer strand the spawned child process**

  Cancelling an in-flight health check or tool discovery (a UI refresh aborting the request, or the 15s discovery timeout) abandoned the MCP connect handshake without closing the transport, leaving the spawned stdio child running indefinitely: for `docker run -i --rm` integrations, one stranded container per interrupted dial. The connect handshake now aborts on interruption (the SDK closes the transport, ending stdin and escalating to SIGTERM/SIGKILL), and tool discovery closes the connection even when the interrupt lands between the handshake completing and discovery starting.

- Updated dependencies [[`a2d1417`](https://github.com/UsefulSoftwareCo/executor/commit/a2d141758e478274813c8c24d354e1fd0f66af49), [`2bdbedf`](https://github.com/UsefulSoftwareCo/executor/commit/2bdbedf257f54d7c209e8c856c618174c10d6bb3)]:
  - @executor-js/sdk@1.6.0
  - @executor-js/react@1.4.63
  - @executor-js/api@1.4.63
  - @executor-js/config@1.6.0

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
