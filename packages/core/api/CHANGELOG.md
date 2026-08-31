# @executor-js/api

## 1.4.70

### Patch Changes

- Updated dependencies [[`98d6c6a`](https://github.com/UsefulSoftwareCo/executor/commit/98d6c6ad3272fca371fc2d8b14b2e332100d8322)]:
  - @executor-js/sdk@1.6.7
  - @executor-js/execution@1.6.7
  - @executor-js/host-mcp@1.4.4

## 1.4.69

### Patch Changes

- Updated dependencies [[`21119da`](https://github.com/UsefulSoftwareCo/executor/commit/21119da662d2d225b033b3532e1f17d97311a39d)]:
  - @executor-js/execution@1.6.6
  - @executor-js/host-mcp@1.4.4
  - @executor-js/sdk@1.6.6

## 1.4.68

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.6.5
  - @executor-js/execution@1.6.5
  - @executor-js/host-mcp@1.4.4

## 1.4.67

### Patch Changes

- Updated dependencies [[`ffcfbc0`](https://github.com/UsefulSoftwareCo/executor/commit/ffcfbc0de27d0ae55215839fb70395b0b7d9a65c), [`10e16a5`](https://github.com/UsefulSoftwareCo/executor/commit/10e16a5baa2648657b70038e7d11429c58e4d242), [`515d6aa`](https://github.com/UsefulSoftwareCo/executor/commit/515d6aa391a04a3579a7b10f974ec316a563cf7a), [`06bf742`](https://github.com/UsefulSoftwareCo/executor/commit/06bf74254f3432e8d75fd8b493ef7a435ea4bc84)]:
  - @executor-js/sdk@1.6.4
  - @executor-js/execution@1.6.4
  - @executor-js/host-mcp@1.4.4

## 1.4.66

### Patch Changes

- Updated dependencies [[`c1f51b7`](https://github.com/UsefulSoftwareCo/executor/commit/c1f51b7f96328b795669bb3d241667660dc2b060), [`02b52cd`](https://github.com/UsefulSoftwareCo/executor/commit/02b52cd01b09d3601ffe88d1f9c0b777f26e76ae)]:
  - @executor-js/sdk@1.6.3
  - @executor-js/execution@1.6.3
  - @executor-js/host-mcp@1.4.4

## 1.4.65

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.6.2
  - @executor-js/execution@1.6.2
  - @executor-js/host-mcp@1.4.4

## 1.4.64

### Patch Changes

- [#1784](https://github.com/UsefulSoftwareCo/executor/pull/1784) [`55180cb`](https://github.com/UsefulSoftwareCo/executor/commit/55180cb1487f9a3a28ddc0ee0bedfab8464c1f72) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - Build `StorageError.message` from the call-site label plus the driver's error code instead of the driver's raw text. The driver text is drizzle's `Failed query: <sql>\nparams: <bound values>`, so error reporting grouped one storage defect by statement shape and printed bound parameters into issue titles. The full driver error stays on `cause`.

  Add `StorageConnectionError`, a `StorageFailure` variant for postgres.js connection faults (`CONNECTION_ENDED`, `CONNECTION_CLOSED`, `CONNECTION_DESTROYED`, `CONNECT_TIMEOUT`, `ECONNREFUSED`, `ECONNRESET`) and workerd's cross-request I/O rejection. It carries the fault `code` and a `retryable` flag so a lost socket can be told apart from a pool-lifetime bug.

- Updated dependencies [[`62748e8`](https://github.com/UsefulSoftwareCo/executor/commit/62748e86122b747226c76c2e112c5c4d2b4f7095), [`d4afe0c`](https://github.com/UsefulSoftwareCo/executor/commit/d4afe0c79f146dd169a00988a2d5d0469297be19), [`55180cb`](https://github.com/UsefulSoftwareCo/executor/commit/55180cb1487f9a3a28ddc0ee0bedfab8464c1f72)]:
  - @executor-js/execution@1.6.1
  - @executor-js/sdk@1.6.1
  - @executor-js/host-mcp@1.4.4

## 1.4.63

### Patch Changes

- Updated dependencies [[`a2d1417`](https://github.com/UsefulSoftwareCo/executor/commit/a2d141758e478274813c8c24d354e1fd0f66af49)]:
  - @executor-js/sdk@1.6.0
  - @executor-js/execution@1.6.0
  - @executor-js/host-mcp@1.4.4

## 1.4.62

### Patch Changes

- Updated dependencies [[`d3f0617`](https://github.com/UsefulSoftwareCo/executor/commit/d3f0617deec06c57e0d6e1479fe668f79daf977d)]:
  - @executor-js/sdk@1.5.42
  - @executor-js/execution@1.5.42
  - @executor-js/host-mcp@1.4.4

## 1.4.61

### Patch Changes

- Updated dependencies [[`d572658`](https://github.com/UsefulSoftwareCo/executor/commit/d572658d74097917412256f10a3ea2e3974f44dd)]:
  - @executor-js/sdk@1.5.41
  - @executor-js/execution@1.5.41
  - @executor-js/host-mcp@1.4.4

## 1.4.60

### Patch Changes

- Updated dependencies [[`8ba64f6`](https://github.com/UsefulSoftwareCo/executor/commit/8ba64f675f6d6ab5302d4f68390c0b055d006f4a)]:
  - @executor-js/sdk@1.5.40
  - @executor-js/execution@1.5.40
  - @executor-js/host-mcp@1.4.4

## 1.4.59

### Patch Changes

- Updated dependencies [[`6c316c7`](https://github.com/UsefulSoftwareCo/executor/commit/6c316c77a9efc98784976236852b58c6156e016e)]:
  - @executor-js/sdk@1.5.39
  - @executor-js/execution@1.5.39
  - @executor-js/host-mcp@1.4.4

## 1.4.58

### Patch Changes

- Updated dependencies [[`6a924dd`](https://github.com/UsefulSoftwareCo/executor/commit/6a924dd98de916d6ff8cea2329bf672f149b64f4)]:
  - @executor-js/sdk@1.5.38
  - @executor-js/execution@1.5.38
  - @executor-js/host-mcp@1.4.4

## 1.4.57

### Patch Changes

- [#1498](https://github.com/UsefulSoftwareCo/executor/pull/1498) [`657b913`](https://github.com/UsefulSoftwareCo/executor/commit/657b9135b8b841495b362936bf60bdca998c16eb) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - Add anonymous product analytics to the local daemon (CLI + desktop) and self-host: execution counts split by MCP/API plane, toolkit usage, integration add/remove, and artifact usage (created/viewed/updated/deleted, attributed to agent tools vs the console UI), filed under a persisted per-install anonymous id. Opt out with DO_NOT_TRACK or EXECUTOR_DISABLE_ANALYTICS.

- Updated dependencies [[`657b913`](https://github.com/UsefulSoftwareCo/executor/commit/657b9135b8b841495b362936bf60bdca998c16eb)]:
  - @executor-js/sdk@1.5.37
  - @executor-js/execution@1.5.37
  - @executor-js/host-mcp@1.4.4

## 1.4.56

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.36
  - @executor-js/execution@1.5.36
  - @executor-js/host-mcp@1.4.4

## 1.4.55

### Patch Changes

- Updated dependencies [[`1b9b1f1`](https://github.com/UsefulSoftwareCo/executor/commit/1b9b1f10313834a625a411169ebf83f6181589df)]:
  - @executor-js/sdk@1.5.35
  - @executor-js/execution@1.5.35
  - @executor-js/host-mcp@1.4.4

## 1.4.54

### Patch Changes

- Updated dependencies [[`e2712db`](https://github.com/UsefulSoftwareCo/executor/commit/e2712dbff98145c5c340832ffbdcb21113b9dd78), [`7207347`](https://github.com/UsefulSoftwareCo/executor/commit/720734756a70b1b4f1564bdf82dc4118e5de2b76), [`0c4e9b4`](https://github.com/UsefulSoftwareCo/executor/commit/0c4e9b49fecb35ad71c92a464c3ea01131ff9d6f)]:
  - @executor-js/sdk@1.5.34
  - @executor-js/execution@1.5.34
  - @executor-js/host-mcp@1.4.4

## 1.4.53

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.33
  - @executor-js/execution@1.5.33
  - @executor-js/host-mcp@1.4.4

## 1.4.52

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.32
  - @executor-js/execution@1.5.32
  - @executor-js/host-mcp@1.4.4

## 1.4.51

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.31
  - @executor-js/execution@1.5.31
  - @executor-js/host-mcp@1.4.4

## 1.4.50

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.30
  - @executor-js/execution@1.5.30
  - @executor-js/host-mcp@1.4.4

## 1.4.49

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.29
  - @executor-js/execution@1.5.29
  - @executor-js/host-mcp@1.4.4

## 1.4.48

### Patch Changes

- Updated dependencies [[`1c48182`](https://github.com/UsefulSoftwareCo/executor/commit/1c4818254e71dc4ee27ff95f489e2c5cf330a450)]:
  - @executor-js/sdk@1.5.28
  - @executor-js/execution@1.5.28
  - @executor-js/host-mcp@1.4.4

## 1.4.47

### Patch Changes

- [#1236](https://github.com/RhysSullivan/executor/pull/1236) [`c7ab1e2`](https://github.com/RhysSullivan/executor/commit/c7ab1e2d56884e0453af85f6399fd25a39f04785) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - Fix self-hosted OAuth popup callbacks failing with "OAuth session expired or not found". When a flow starts from an organization context, the state token is wrapped with the org slug before it is sent to the provider. The shared popup callback now unwraps that state and uses the raw token for both session lookup and popup result correlation, while raw (unwrapped) callback state continues to pass through unchanged.

- Updated dependencies []:
  - @executor-js/sdk@1.5.27
  - @executor-js/execution@1.5.27
  - @executor-js/host-mcp@1.4.4

## 1.4.46

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.26
  - @executor-js/execution@1.5.26
  - @executor-js/host-mcp@1.4.4

## 1.4.45

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.25
  - @executor-js/execution@1.5.25
  - @executor-js/host-mcp@1.4.4

## 1.4.44

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.24
  - @executor-js/execution@1.5.24
  - @executor-js/host-mcp@1.4.4

## 1.4.43

### Patch Changes

- [#1199](https://github.com/RhysSullivan/executor/pull/1199) [`29936d5`](https://github.com/RhysSullivan/executor/commit/29936d5981256f8f953797d9ce8ce073ac6a0b6a) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - Fix OAuth "Mismatching redirect URI" for org-scoped client-id metadata documents

  Org-scoped client-id metadata documents registered their callback as
  `redirect_uri` with an `executor_org` query param, but the client always sends
  the bare callback and the org is carried in the OAuth `state`. Providers that
  compare `redirect_uri` as an exact string (such as PostHog) rejected the
  authorize request. Org targets now keep their distinct `client_id` URL but
  register the same bare callback `redirect_uri` as every other target.

- [#1199](https://github.com/RhysSullivan/executor/pull/1199) [`29936d5`](https://github.com/RhysSullivan/executor/commit/29936d5981256f8f953797d9ce8ce073ac6a0b6a) Thanks [@RhysSullivan](https://github.com/RhysSullivan)! - Notify when a newer Executor is published. The CLI now prints an "update available" line under its ready banner, and the web shell's sidebar update card works for real (a new `/v1/app/npm/dist-tags` endpoint backs it). In the desktop app the card shows a native "Restart to update" action wired to the in-app updater instead of the npm command. The check is best-effort and offline-safe, and can be disabled with `EXECUTOR_DISABLE_UPDATE_CHECK`.

- Updated dependencies []:
  - @executor-js/sdk@1.5.23
  - @executor-js/execution@1.5.23
  - @executor-js/host-mcp@1.4.4

## 1.4.42

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.22
  - @executor-js/execution@1.5.22
  - @executor-js/host-mcp@1.4.4

## 1.4.41

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.21
  - @executor-js/execution@1.5.21
  - @executor-js/host-mcp@1.4.4

## 1.4.40

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.20
  - @executor-js/execution@1.5.20
  - @executor-js/host-mcp@1.4.4

## 1.4.39

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.19
  - @executor-js/execution@1.5.19
  - @executor-js/host-mcp@1.4.4

## 1.4.38

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.18
  - @executor-js/execution@1.5.18
  - @executor-js/host-mcp@1.4.4

## 1.4.37

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.17
  - @executor-js/execution@1.5.17
  - @executor-js/host-mcp@1.4.4

## 1.4.36

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.16
  - @executor-js/execution@1.5.16
  - @executor-js/host-mcp@1.4.4

## 1.4.35

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.15
  - @executor-js/execution@1.5.15
  - @executor-js/host-mcp@1.4.4

## 1.4.34

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.14
  - @executor-js/execution@1.5.14
  - @executor-js/host-mcp@1.4.4

## 1.4.33

### Patch Changes

- Updated dependencies [[`8244fee`](https://github.com/RhysSullivan/executor/commit/8244fee567cb2408650fc1fcd1a9e72cedc2f683)]:
  - @executor-js/execution@1.5.13
  - @executor-js/host-mcp@1.4.4
  - @executor-js/sdk@1.5.13

## 1.4.32

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.12
  - @executor-js/execution@1.5.12
  - @executor-js/host-mcp@1.4.4

## 1.4.31

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.11
  - @executor-js/execution@1.5.11
  - @executor-js/host-mcp@1.4.4

## 1.4.30

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.10
  - @executor-js/execution@1.5.10
  - @executor-js/host-mcp@1.4.4

## 1.4.29

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.9
  - @executor-js/execution@1.5.9
  - @executor-js/host-mcp@1.4.4

## 1.4.28

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.8
  - @executor-js/execution@1.5.8
  - @executor-js/host-mcp@1.4.4

## 1.4.27

### Patch Changes

- Updated dependencies [[`7cee242`](https://github.com/RhysSullivan/executor/commit/7cee242f07687b0d8711201c620d8c61594adc15), [`7cee242`](https://github.com/RhysSullivan/executor/commit/7cee242f07687b0d8711201c620d8c61594adc15)]:
  - @executor-js/sdk@1.5.7
  - @executor-js/execution@1.5.7
  - @executor-js/host-mcp@1.4.4

## 1.4.26

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.4
  - @executor-js/execution@1.5.4
  - @executor-js/host-mcp@1.4.4

## 1.4.25

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.3
  - @executor-js/execution@1.5.3
  - @executor-js/host-mcp@1.4.4

## 1.4.24

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.2
  - @executor-js/execution@1.5.2
  - @executor-js/host-mcp@1.4.4

## 1.4.23

### Patch Changes

- Updated dependencies []:
  - @executor-js/sdk@1.5.1
  - @executor-js/execution@1.5.1
  - @executor-js/host-mcp@1.4.4

## 1.4.22

### Patch Changes

- Updated dependencies [[`7d7fbbd`](https://github.com/RhysSullivan/executor/commit/7d7fbbda9c0912e70334dcc809ec755ba3328f68), [`1ba0193`](https://github.com/RhysSullivan/executor/commit/1ba01932919e6aee25a76c4c093841df8539adad)]:
  - @executor-js/sdk@1.5.0
  - @executor-js/execution@1.5.0
  - @executor-js/host-mcp@1.4.4
