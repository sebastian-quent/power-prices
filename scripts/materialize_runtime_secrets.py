"""Resolves the READ_ONLY_USER secret (`ai/db/quent`) once (needs real AWS access - run this
locally/wherever that's available, not on the Docker host) and writes just the password to a
local file for docker-compose to mount as a Docker secret. This dashboard only ever calls
PriceStore.get()/SELECT, so it uses the scoped read-only role rather than the shared
prod/db/quent credential local dev's get_engine_quent() uses - narrower blast radius for a
credential that sits in a container. host/user aren't secret (same convention as
quent-data-stream's own materialize script) - they're printed here so they can be set once as
DB_HOST/DB_USER in the deploy .env, not written to disk.

Usage: poetry run python scripts/materialize_runtime_secrets.py [--output-dir .runtime]
"""

from __future__ import annotations

import argparse
import os
from pathlib import Path

from quent_core.utils.secrets import SecretsManagerClient
from quent_core.utils.settings import load_dotenv_once

SECRET_NAME = "ai/db/quent"


def _write(path: Path, value: str, mode: int = 0o600) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if not value.endswith("\n"):
        value += "\n"
    path.write_text(value, encoding="utf-8", newline="\n")
    try:
        os.chmod(path, mode)
    except OSError:
        pass


def materialize(output_dir: str | Path = ".runtime") -> None:
    load_dotenv_once()
    db = SecretsManagerClient().get_secret(SECRET_NAME)
    _write(Path(output_dir) / "db/password", db["password"])
    print(f"[ok] wrote {Path(output_dir) / 'db/password'}")
    print("[info] set these once in the deploy .env (not secret, not written to disk):")
    print(f"  DB_HOST={db['host']}")
    print(f"  DB_USER={db['username']}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-dir", default=".runtime")
    args = parser.parse_args()

    materialize(args.output_dir)


if __name__ == "__main__":
    main()
