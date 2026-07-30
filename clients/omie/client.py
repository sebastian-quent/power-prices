import datetime as dt
import logging
import re
import time
from typing import Optional

import pandas as pd
import requests
from lxml import html

logger = logging.getLogger(__name__)

HOST = "https://www.omie.es"
LIST_URL = f"{HOST}/en/file-access-list"
DOWNLOAD_URL = f"{HOST}/en/file-download"

RETRY_ATTEMPTS = 2 
RETRY_BACKOFF_SECONDS = 10


REQUEST_TIMEOUT_SECONDS = 30


def _get(url: str, params: dict) -> Optional[requests.Response]:
    """GET with one retry on failure, shared by list_files and download_file.

    public, unauthenticated file browser.
    """
    for attempt in range(1, RETRY_ATTEMPTS + 1):
        try:
            response = requests.get(url, params=params, timeout=REQUEST_TIMEOUT_SECONDS)
            response.raise_for_status()
            return response
        except requests.RequestException as exc:
            if attempt < RETRY_ATTEMPTS:
                logger.warning(
                    "OMIE request to %s failed (attempt %d/%d): %s - retrying in %ds",
                    url, attempt, RETRY_ATTEMPTS, exc, RETRY_BACKOFF_SECONDS,
                )
                time.sleep(RETRY_BACKOFF_SECONDS)
            else:
                logger.error("OMIE request to %s failed after %d attempt(s)", url, RETRY_ATTEMPTS, exc_info=True)
                return None


def list_files(realdir: str, dir_label: str, parents: str) -> Optional[dict[dt.date, tuple[str, pd.Timestamp]]]:
    """list published files for one OMIE file-access directory, keyed by delivery date.

    reused by every endpoint that reads published daily files - shared here
    rather than per-endpoint, same shape as clients/semo/client.py's list_documents.

    OMIE republishes corrected files under an incremented version suffix
    (marginalpdbcpt_20230121.3 superseding .1/.2) - the file-access-list page is expected
    to list just the current version per date, but if a correction is mid-publish (or row
    order isn't append-only) more than one suffix could appear for the same date, so the
    highest suffix per date is kept explicitly rather than trusting last-write-wins.
    """
    response = _get(LIST_URL, params={"parents": parents, "dir": dir_label, "realdir": realdir})
    if response is None:
        return None

    pattern = re.compile(rf"^{re.escape(realdir)}_(\d{{8}})\.(\d+)$")
    tree = html.fromstring(response.content)
    best_suffix: dict[dt.date, int] = {}
    files: dict[dt.date, tuple[str, pd.Timestamp]] = {}
    for row in tree.xpath("//tr[td]"):
        cells = row.xpath("./td/@data-val")
        if len(cells) < 3:
            continue
        filename, _size, mtime = cells[0], cells[1], cells[2]
        match = pattern.match(filename)
        if match is None:
            continue
        date = dt.datetime.strptime(match.group(1), "%Y%m%d").date()
        suffix = int(match.group(2))
        if date in best_suffix and suffix <= best_suffix[date]:
            continue
        best_suffix[date] = suffix
        files[date] = (filename, pd.Timestamp(int(mtime), unit="s", tz="UTC"))
    return files


def download_file(realdir: str, filename: str) -> Optional[bytes]:
    """download the raw content of one published OMIE file."""
    response = _get(DOWNLOAD_URL, params={"parents": realdir, "filename": filename})
    return response.content if response is not None else None
