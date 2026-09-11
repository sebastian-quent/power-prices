"""DB engine for the dashboard - resolves via quent_core's shared secret when AWS access
is available (local dev, via AWS_PROFILE), or from a materialized Docker secret file when
it isn't (the Docker deployment - see scripts/materialize_runtime_secrets.py and
project-overview.md > Docker deployment for why the container can't do its own AWS lookup)."""

import os
from pathlib import Path

from sqlalchemy import create_engine
from sqlalchemy.engine import Engine


def get_engine() -> Engine:
    password_file = os.getenv("DB_PASSWORD_FILE")
    if not password_file:
        from quent_core.database.db_connect import get_engine_quent

        return get_engine_quent()

    host = os.environ["DB_HOST"]
    user = os.environ["DB_USER"]
    password = Path(password_file).read_text().strip()
    return create_engine(f"postgresql+psycopg2://{user}:{password}@{host}/postgres")
