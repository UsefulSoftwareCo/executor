# @executor-js/api

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
