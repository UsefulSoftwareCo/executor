# Source setup orchestration

The web source-add flow currently owns a lot of business logic that agents have
to rediscover through low-level tools: preset lookup, URL-to-endpoint mapping,
endpoint probing, OAuth strategy choice, connection id generation, browser
handoff, credential binding, and final source registration.

Longer term, consider moving this into an SDK-level source setup service so the
frontend and agent tools share the same state machine. The frontend would render
steps from the service, while agent tools would return the same state with
model-facing `instructions` fields. Keep low-level plugin tools as escape
hatches, but make common preset flows first-class.
