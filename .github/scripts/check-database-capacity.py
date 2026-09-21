"""Read aggregate connection capacity with libpq; never print credentials or SQL data."""

import json
import os
import subprocess
import sys
from urllib.parse import unquote, urlparse


def main() -> int:
    try:
        url = urlparse(os.environ["DATABASE_URL"])
        if url.scheme not in ("postgres", "postgresql") or not url.hostname:
            raise ValueError("Invalid database URL")
        if url.hostname.endswith(".psdb.cloud") and url.port not in (None, 5432):
            raise ValueError("Capacity checks require the direct endpoint")
        env = {
            **os.environ,
            "PGHOST": url.hostname,
            "PGPORT": str(url.port or 5432),
            "PGUSER": unquote(url.username or ""),
            "PGPASSWORD": unquote(url.password or ""),
            "PGDATABASE": unquote(url.path.removeprefix("/")),
            "PGSSLMODE": "require",
            "PGCONNECT_TIMEOUT": "10",
            "PGAPPNAME": "database-capacity-check",
            "PGOPTIONS": "-c default_transaction_read_only=on -c statement_timeout=10000",
        }
        result = subprocess.run(
            ["psql", "-X", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-c", """
                SELECT json_build_object(
                    'limit', current_setting('max_connections')::int,
                    'reserved', current_setting('superuser_reserved_connections')::int
                        + current_setting('reserved_connections')::int,
                    'used', count(*)::int
                ) FROM pg_stat_activity WHERE backend_type = 'client backend'
            """],
            env=env,
            capture_output=True,
            text=True,
            timeout=25,
            check=True,
        )
        capacity = json.loads(result.stdout)
        if any(type(capacity[key]) is not int for key in ("limit", "reserved", "used")):
            raise ValueError("Invalid capacity response")
        free = capacity["limit"] - capacity["reserved"] - capacity["used"]
        print(json.dumps({**capacity, "ordinary_free": free, "minimum_free": 10}))
        if free < 10:
            print("::error::Database connection headroom is below 10 slots. Inspect direct clients and the PgBouncer budget.")
            return 1
        return 0
    except (KeyError, ValueError, OSError, subprocess.SubprocessError):
        print("::error::Database capacity check failed. Check direct endpoint access and provider health.")
        return 1


if __name__ == "__main__":
    sys.exit(main())
