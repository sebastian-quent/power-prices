# power-prices

> **Live at `http://192.168.1.202:8080/`** - running in Docker on the same internal server.

FastAPI + plain-JS map dashboard for European day-ahead and intraday electricity prices -
shows per-bidding-zone coverage and price level on a map, with a day picker and a per-source
completeness/price-curve breakdown on hover.

## Run locally

```
poetry run uvicorn dashboard.app:app --reload --port 8000
```

Pinned to port 8000 explicitly rather than left to uvicorn's unstated default.

## Docker deployment

Deployed via `docker-compose.yml`/`Dockerfile`, published on port 8080. The container has no
live AWS access, so its DB credential (the READ_ONLY_USER role) is resolved once elsewhere and
mounted in as a Docker secret rather than fetched live.

---

See `project-overview.md` for scope, architecture, data model, and the underlying `prod.prices`
pipeline (owned by the sibling `scrapers` repo).
