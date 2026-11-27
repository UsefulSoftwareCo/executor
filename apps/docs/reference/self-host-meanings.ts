export const meanings: Readonly<Record<string, string>> = {
  BETTER_AUTH_SECRET:
    "Signs dashboard sessions and must have at least 32 characters when supplied.",
  BETTER_AUTH_URL:
    "Sets the public HTTP(S) origin, without a trailing slash, used for sign-in and links.",
  DO_NOT_TRACK:
    "Opts out of usage analytics when set to a truthy value such as `1`. OTLP export is configured separately.",
  EXECUTOR_ANALYTICS_SECRET:
    "Derives stable pseudonymous user IDs by hashing them with an installation-specific HMAC key.",
  EXECUTOR_ANALYTICS_TEST_PORT: "Routes usage analytics to a local listener when `NODE_ENV=test`.",
  EXECUTOR_APPS_ALLOW_PRIVATE_FETCH:
    "Allows app code to send requests to private network destinations.",
  EXECUTOR_APP_UI_BASE_URL:
    "Sets the base for isolated app UI origins. Localhost derives it from the dashboard origin.",
  EXECUTOR_APP_WORKERS: "Limits the number of app and app-data workers kept loaded.",
  EXECUTOR_APP_WORKER_IDLE_SECONDS:
    "Sets the idle unload delay in seconds. Zero disables idle unloading.",
  EXECUTOR_BUILD_VERSION:
    "Identifies the build in telemetry and selects the installed version for update checks.",
  EXECUTOR_CATALOG_URL: "Selects the catalog index URL. Use `off` to disable the catalog.",
  EXECUTOR_DATA_DIR: "Selects the persistent directory for storage and generated keys.",
  EXECUTOR_DESKTOP_SESSION_LINK_SECONDS:
    "Sets how long a desktop sign-in link stays valid in seconds.",
  EXECUTOR_DISABLE_ANALYTICS:
    "Opts out of usage analytics when set to a truthy value such as `1`. OTLP export is configured separately.",
  EXECUTOR_ENCRYPTION_KEY:
    "Encrypts stored credentials and must be 64 hexadecimal characters when supplied.",
  EXECUTOR_ENVIRONMENT: "Labels telemetry with the deployment environment.",
  EXECUTOR_EVALUATION_MEMORY_MB: "Sets the memory budget for cached app evaluation data.",
  EXECUTOR_HOST_ARCH: "Read-only host architecture reported in usage analytics.",
  EXECUTOR_HOST_OS: "Read-only host operating system reported in usage analytics.",
  EXECUTOR_HOST_STALL_RESTART:
    "Makes the host process exit when it detects a stall. Docker restarts it only if a restart policy applies.",
  EXECUTOR_HOST_STALL_SECONDS:
    "Sets the busy-second threshold for detecting a stall. Zero disables detection.",
  EXECUTOR_INSTALL_ID:
    "Identifies this installation across restarts. Usage analytics sends this ID and the root domain when eligible.",
  EXECUTOR_MCP_CLIENTS:
    "Caps retained MCP clients across the installation before idle clients are evicted.",
  EXECUTOR_MCP_CLIENTS_PER_USER:
    "Caps retained MCP clients per user before that user's idle clients are evicted.",
  EXECUTOR_MCP_TIMEOUT_MS: "Limits the duration of an MCP execution in milliseconds.",
  EXECUTOR_MOTEL_DATA_DIR: "Selects the bundled telemetry collector's data directory in Docker.",
  EXECUTOR_NO_UPDATE_CHECK: "Disables the periodic check for newer Executor releases.",
  EXECUTOR_NPM_REGISTRY:
    "Overrides the public npm registry used for app builds and version checks.",
  EXECUTOR_OAUTH_CALLBACK_URL: "Overrides the callback URL for provider OAuth flows.",
  EXECUTOR_OAUTH_CLIENT_METADATA_URL:
    "Enables and names the HTTPS client metadata document for provider OAuth.",
  EXECUTOR_OAUTH_GITHUB_CLIENT_ID: "Supplies the operator's OAuth client ID for GitHub accounts.",
  EXECUTOR_OAUTH_GITHUB_CLIENT_SECRET:
    "Supplies the operator's OAuth client secret for GitHub accounts.",
  EXECUTOR_OAUTH_GOOGLE_CLIENT_ID: "Supplies the operator's OAuth client ID for Google accounts.",
  EXECUTOR_OAUTH_GOOGLE_CLIENT_SECRET:
    "Supplies the operator's OAuth client secret for Google accounts.",
  EXECUTOR_OAUTH_SLACK_CLIENT_ID: "Supplies the operator's OAuth client ID for Slack accounts.",
  EXECUTOR_OAUTH_SLACK_CLIENT_SECRET:
    "Supplies the operator's OAuth client secret for Slack accounts.",
  EXECUTOR_POSTHOG_HOST: "Selects the HTTPS destination for usage analytics.",
  EXECUTOR_POSTHOG_PUBLIC_KEY:
    "Supplies the public ingestion key that enables usage analytics with a destination.",
  EXECUTOR_REGISTRY_URL: "Selects the public origin used to publish and install apps.",
  EXECUTOR_REPOSITORIES_DIR: "Read-only path where the Docker host keeps app Git repositories.",
  EXECUTOR_RUNTIME_DIR: "Selects the Docker directory containing the packaged Worker runtime.",
  EXECUTOR_SCHEDULE_CONCURRENCY: "Limits how many scheduled app jobs can run concurrently.",
  EXECUTOR_STORAGE_EXPORT:
    "Internal Worker flag. When true, normal product requests return HTTP 503. Use `executor-host export` to write an export file.",
  EXECUTOR_TEST_OAUTH_CLIENT_DEFINITIONS:
    "Adds synthetic OAuth client definitions on an end-to-end test host.",
  EXECUTOR_TOOL_LISTING_FRESH_SECONDS: "Sets how long a cached tool listing is treated as fresh.",
  EXECUTOR_TOOL_LISTING_LOAD_SECONDS: "Limits how long a tool listing load may run.",
  EXECUTOR_TOOL_LISTING_MAX_AGE_SECONDS:
    "Sets the maximum age of a cached tool listing that can be served.",
  EXECUTOR_TOOL_LISTING_RENEW_SECONDS:
    "Sets how long a cached tool listing can wait before background renewal.",
  EXECUTOR_TRUSTED_PROXIES:
    "Lists the trusted proxy IP addresses or CIDR ranges allowed to supply client IPs.",
  EXECUTOR_URL_ALLOW_HTTP_ORIGINS:
    "Lists exact HTTP(S) origins granted an exception to outbound URL checks.",
  EXECUTOR_URL_ALLOW_LOOPBACK_HTTP:
    "Allows HTTP URLs on loopback addresses in outbound URL checks.",
  HOST: "Sets the network interface address the server binds.",
  NODE_ENV: "Selects the environment used to configure usage analytics.",
  NODE_EXTRA_CA_CERTS: "Points the Docker host to additional PEM certificates for outbound TLS.",
  OTEL_EXPORTER_OTLP_ENDPOINT:
    "Sets the base OTLP URL from which per-signal endpoints are derived.",
  OTEL_EXPORTER_OTLP_HEADERS: "Provides fallback request headers for all OTLP exporters.",
  OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "Overrides the full OTLP logs export URL.",
  OTEL_EXPORTER_OTLP_LOGS_HEADERS: "Overrides request headers for the logs exporter.",
  OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "Overrides the full OTLP metrics export URL.",
  OTEL_EXPORTER_OTLP_METRICS_HEADERS: "Overrides request headers for the metrics exporter.",
  OTEL_EXPORTER_OTLP_METRICS_PROTOCOL: "Selects `http/protobuf` or `http/json` for metric export.",
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "Overrides the full OTLP traces export URL.",
  OTEL_EXPORTER_OTLP_TRACES_HEADERS: "Overrides request headers for the traces exporter.",
  PORT: "Sets the server's listening port.",
  RAILWAY_PUBLIC_DOMAIN:
    "Supplies the hostname for the public origin when Railway provides a domain.",
  SSL_CERT_DIR: "Points the workerd runtime to a directory of trusted TLS certificates.",
  SSL_CERT_FILE: "Points the workerd runtime to a trusted CA certificate bundle.",
  SSO_ALLOWED_DOMAINS:
    "Required with SSO. Lists the email domains allowed to sign in, separated by commas.",
  SSO_CLIENT_ID: "Required with SSO. Identifies Executor to the configured OIDC provider.",
  SSO_CLIENT_SECRET:
    "Required with SSO. Supplies Executor's secret for the configured OIDC provider.",
  SSO_DISCOVERY_URL: "Enables single sign-on with the provider's HTTPS OIDC discovery document.",
};

export const settingDetails: Readonly<Record<string, { type?: string; fallback?: string }>> = {
  EXECUTOR_ANALYTICS_SECRET: { type: "64 hexadecimal characters" },
  EXECUTOR_ANALYTICS_TEST_PORT: { type: "positive integer" },
  EXECUTOR_APP_WORKERS: { type: "positive integer" },
  EXECUTOR_APP_WORKER_IDLE_SECONDS: { type: "nonnegative integer" },
  EXECUTOR_ENVIRONMENT: { fallback: '`"development"` for telemetry, `""` for test detection' },
  EXECUTOR_HOST_STALL_SECONDS: { type: "integer, 0–3600" },
  EXECUTOR_INSTALL_ID: { type: "UUID v4" },
  PORT: { type: "integer, 1–65535" },
  SSO_ALLOWED_DOMAINS: { fallback: "Required when SSO is enabled" },
  SSO_CLIENT_ID: { fallback: "Required when SSO is enabled" },
  SSO_CLIENT_SECRET: { fallback: "Required when SSO is enabled" },
};
