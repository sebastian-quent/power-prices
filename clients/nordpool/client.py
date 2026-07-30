import logging
import time
from typing import Optional

import requests

logger = logging.getLogger(__name__)

BASE_URL = "https://dataportal-api.nordpoolgroup.com/api"

RETRY_ATTEMPTS = 2
RETRY_BACKOFF_SECONDS = 10


def fetch(endpoint: str, params: dict) -> Optional[dict]:
    """GET request against the Nord Pool data portal API.

    shared by all endpoints/*.py modules. currently unauthenticated - add auth
    headers here once an endpoint needs them, so it applies to all callers.
    retries once after a fixed backoff on any request failure, then returns None
    so callers can skip/continue instead of crashing the run. A 401 (date outside
    the free API's ~2-month rolling window, see project-overview.md) is a permanent
    result, not a transient failure, so it's not retried.
    """
    for attempt in range(1, RETRY_ATTEMPTS + 1):
        try:
            response = requests.get(f"{BASE_URL}/{endpoint}", params=params, timeout=30)
            response.raise_for_status()
            return response.json()
        except requests.HTTPError as exc:
            if exc.response is not None and exc.response.status_code == 401:
                logger.warning("Nord Pool request to %s returned 401 (outside rolling window) - not retrying", endpoint)
                return None
            if attempt < RETRY_ATTEMPTS:
                logger.warning(
                    "Nord Pool request to %s failed (attempt %d/%d): %s - retrying in %ds",
                    endpoint, attempt, RETRY_ATTEMPTS, exc, RETRY_BACKOFF_SECONDS,
                )
                time.sleep(RETRY_BACKOFF_SECONDS)
            else:
                logger.error("Nord Pool request to %s failed after %d attempt(s)", endpoint, RETRY_ATTEMPTS, exc_info=True)
                return None
        except requests.RequestException as exc:
            if attempt < RETRY_ATTEMPTS:
                logger.warning(
                    "Nord Pool request to %s failed (attempt %d/%d): %s - retrying in %ds",
                    endpoint, attempt, RETRY_ATTEMPTS, exc, RETRY_BACKOFF_SECONDS,
                )
                time.sleep(RETRY_BACKOFF_SECONDS)
            else:
                logger.error("Nord Pool request to %s failed after %d attempt(s)", endpoint, RETRY_ATTEMPTS, exc_info=True)
                return None
