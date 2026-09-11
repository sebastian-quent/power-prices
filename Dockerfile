FROM python:3.12.9-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    POETRY_VIRTUALENVS_CREATE=false \
    POETRY_VERSION=2.4.1

WORKDIR /app

# build-essential + libpq-dev: psycopg2 (not psycopg2-binary) compiles from source at install
# time. git: quent_core is installed straight from its GitHub repo, not PyPI.
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential libpq-dev git ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

COPY pyproject.toml poetry.lock ./

RUN pip install "poetry==$POETRY_VERSION" \
    && poetry install --no-root --only main --no-interaction --no-ansi

COPY core ./core
COPY dashboard ./dashboard

EXPOSE 8000

CMD ["uvicorn", "dashboard.app:app", "--host", "0.0.0.0", "--port", "8000"]
