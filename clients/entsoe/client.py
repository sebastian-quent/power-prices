import ast
import logging
import time
from typing import Optional

import requests
from quent_core.utils.settings import load_setting

logger = logging.getLogger(__name__)

RETRY_ATTEMPTS = 2
RETRY_BACKOFF_SECONDS = 10

_host: Optional[str] = None
_api_key: Optional[str] = None


def fetch(params: dict) -> Optional[bytes]:
    """GET request against the ENTSO-E Transparency Platform API.

    shared by all endpoints/*.py modules - each builds its own params dict
    (documentType, processType, domain, etc.) and passes it here. returns raw
    response bytes so callers can parse the document shape relevant to them.
    retries once after a fixed backoff on any request failure, then returns None
    so callers can skip/continue instead of crashing the run.
    """
    global _host, _api_key
    if _host is None:
        _host = load_setting("entsoe.host", resolve_secret=False)
    if _api_key is None:
        raw_api_keys = load_setting("entsoe.api_key", resolve_secret=True)
        _api_key = ast.literal_eval(raw_api_keys)[0]

    request_params = {"securityToken": _api_key, **params}
    for attempt in range(1, RETRY_ATTEMPTS + 1):
        try:
            response = requests.get(_host, params=request_params, timeout=30)
            response.raise_for_status()
            return response.content
        except requests.RequestException as exc:
            if attempt < RETRY_ATTEMPTS:
                logger.warning(
                    "ENTSO-E request failed for params %s (attempt %d/%d): %s - retrying in %ds",
                    params, attempt, RETRY_ATTEMPTS, exc, RETRY_BACKOFF_SECONDS,
                )
                time.sleep(RETRY_BACKOFF_SECONDS)
            else:
                logger.error("ENTSO-E request failed for params %s after %d attempt(s)", params, RETRY_ATTEMPTS, exc_info=True)
                return None
