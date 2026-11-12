#!/usr/bin/env bash
# Run one command with a short-lived Cloudflare API token that can only use Artifacts on one account.
#
#   CF_TOKEN=<a token that may create API tokens> \
#     with-artifacts-token.sh <read|write> <account id> -- <command> [args...]
#
# The test-stage token cannot read Artifacts, and `test-stage destroy --by-name` refuses to remove a
# stage whose Artifacts namespace it cannot confirm empty (notes/test-stages.md). This script mints
# a token named "executor test-stage artifacts <mode> (temporary)" with the permission group
# "Artifacts Read" (and "Artifacts Write", which the dashboard calls Edit, for `write`) on that
# account only, expiring in 20 minutes. It waits until Artifacts accepts the token, gives it to the
# command as CLOUDFLARE_ARTIFACTS_TOKEN, and deletes it when the command ends. The token's value is
# never printed or written to disk, and CF_TOKEN is not passed on to the command. A token with only
# Artifacts Read has been seen to list the account's Workers as well, so treat it as broader than
# its name: one short command per token.
set -euo pipefail

mode=${1:?read or write}
account=${2:?account id}
[ "${3:-}" = "--" ] || { echo "usage: $0 <read|write> <account id> -- <command>" >&2; exit 2; }
shift 3
[ "$mode" = read ] || [ "$mode" = write ] || { echo "mode must be read or write" >&2; exit 2; }
[[ "$account" =~ ^[a-f0-9]{32}$ ]] || { echo "account id must be 32 hex characters" >&2; exit 2; }
: "${CF_TOKEN:?CF_TOKEN is not set}"

api=https://api.cloudflare.com/client/v4
minted=""
cleanup() {
  if [ -n "$minted" ]; then
    curl -sS -m 20 -o /dev/null -X DELETE -H "Authorization: Bearer $CF_TOKEN" "$api/user/tokens/$minted" \
      || echo "warning: could not delete temporary token $minted; it expires within 20 minutes" >&2
  fi
}
trap cleanup EXIT

groups=$(curl -sS -m 20 -H "Authorization: Bearer $CF_TOKEN" "$api/user/tokens/permission_groups")
body=$(MODE=$mode ACCOUNT=$account GROUPS_JSON=$groups python3 -I -c '
import json, os, datetime
groups = {g["name"]: g["id"] for g in json.loads(os.environ["GROUPS_JSON"])["result"]}
wanted = ["Artifacts Read"] + (["Artifacts Write"] if os.environ["MODE"] == "write" else [])
now = datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0)
stamp = lambda t: t.strftime("%Y-%m-%dT%H:%M:%SZ")
print(json.dumps({
    "name": "executor test-stage artifacts %s (temporary)" % os.environ["MODE"],
    "policies": [{
        "effect": "allow",
        "resources": {"com.cloudflare.api.account." + os.environ["ACCOUNT"]: "*"},
        "permission_groups": [{"id": groups[name]} for name in wanted],
    }],
    "not_before": stamp(now - datetime.timedelta(minutes=1)),
    "expires_on": stamp(now + datetime.timedelta(minutes=20)),
}))')

created=$(curl -sS -m 20 -X POST -H "Authorization: Bearer $CF_TOKEN" -H "Content-Type: application/json" \
  --data "$body" "$api/user/tokens")
minted=$(printf '%s' "$created" | python3 -I -c '
import json, sys
d = json.load(sys.stdin)
if not d.get("success"):
    sys.stderr.write("could not create the temporary token: %s\n" % d.get("errors"))
    sys.exit(1)
print(d["result"]["id"])')
value=$(printf '%s' "$created" | python3 -I -c 'import json, sys; print(json.load(sys.stdin)["result"]["value"])')
unset created body groups

# A new token is refused for a few seconds after it is created. Wait until Artifacts accepts it.
ready=""
for _ in 1 2 3 4 5 6 7 8 9 10; do
  code=$(curl -sS -m 20 -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $value" \
    "$api/accounts/$account/artifacts/namespaces?per_page=1") || code=000
  if [ "$code" = 200 ]; then ready=1; break; fi
  sleep 3
done
[ -n "$ready" ] || { echo "the temporary token was not accepted by Artifacts within 30 seconds (last HTTP $code)" >&2; exit 1; }

status=0
env -u CF_TOKEN CLOUDFLARE_ARTIFACTS_TOKEN="$value" "$@" || status=$?
exit $status
