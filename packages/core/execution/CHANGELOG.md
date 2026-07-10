# @executor-js/execution

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
