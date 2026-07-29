"""
Registers this repo's day-ahead flows as Prefect deployments on the shared Prefect
server, on their own work pool (see project-overview.md > Scheduling).

Deliberately independent of Production/Algos' deployment tooling (own work pool,
own venv, own deploy script) so this repo's flows never run under Production's or
Algos' Python environment - see project-overview.md > Open items and CLAUDE.md's
poetry/.venv note.

Run with: poetry run python Prefect/deploy_flows.py
"""
import os
from typing import List, Optional

from prefect import flow
from prefect.client.orchestration import get_client
from prefect.schedules import Cron

WORK_POOL_NAME = "day_ahead_prices"
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def deploy_flow(entrypoint: str, cron: str = "", tags: Optional[List[str]] = None, cron_list: Optional[List[str]] = None):
    name = entrypoint.split(":")[-1]

    flow_instance = flow.from_source(
        source=REPO_ROOT,
        entrypoint=entrypoint,
    )

    if cron_list is not None:
        schedule = None
        schedules = [Cron(sub_cron, timezone="Europe/Copenhagen") for sub_cron in cron_list]
    else:
        schedule = Cron(cron, timezone="Europe/Copenhagen")
        schedules = None

    flow_instance.deploy(
        name=name,
        work_pool_name=WORK_POOL_NAME,
        schedule=schedule,
        schedules=schedules,
        tags=tags or [],
        ignore_warnings=True,
    )


async def remove_deployments():
    """Removes every existing deployment on this pool before re-registering.

    Scoped to WORK_POOL_NAME only - never touches Production/Algos' 'prod'/'algos'
    pool deployments.
    """
    async with get_client() as client:
        deployments = await client.read_deployments()
        for deployment in deployments:
            if deployment.work_pool_name == WORK_POOL_NAME:
                print(f"Deleting deployment: {deployment.name}")
                await client.delete_deployment(deployment.id)


def deploy_all():
    # Nordpool
    deploy_flow(
        entrypoint="clients/nordpool/endpoints/day_ahead.py:run",
        cron="*/15 13-14 * * *",
        tags=["nordpool", "day_ahead"],
    )
    deploy_flow(
        entrypoint="clients/nordpool/endpoints/day_ahead_gb.py:run",
        cron_list=["*/15 11-12 * * *", "*/15 15-16 * * *"],
        tags=["nordpool", "day_ahead", "gb"],
    )

    # EPEX
    deploy_flow(
        entrypoint="clients/epex/endpoints/day_ahead.py:run",
        cron="*/15 13-14 * * *",
        tags=["epex", "day_ahead"],
    )
    deploy_flow(
        entrypoint="clients/epex/endpoints/day_ahead.py:run_gb",
        cron_list=["*/15 11-12 * * *", "*/15 15-16 * * *"],
        tags=["epex", "day_ahead", "gb"],
    )

    # ENTSO-E
    deploy_flow(
        entrypoint="clients/entsoe/endpoints/day_ahead.py:run",
        cron="*/15 13-14 * * *",
        tags=["entsoe", "day_ahead"],
    )
    deploy_flow(
        entrypoint="clients/entsoe/endpoints/day_ahead.py:run_ie",
        cron="*/15 12-13 * * *",
        tags=["entsoe", "day_ahead", "ie"],
    )

    # Single-zone local sources
    deploy_flow(
        entrypoint="clients/ote/endpoints/day_ahead.py:run",
        cron="*/15 13-14 * * *",
        tags=["ote", "day_ahead"],
    )
    deploy_flow(
        entrypoint="clients/semo/endpoints/day_ahead.py:run",
        cron="5,20,35,50 1-2 * * *",
        tags=["semo", "day_ahead"],
    )
    deploy_flow(
        entrypoint="clients/opcom/endpoints/day_ahead.py:run",
        cron="*/15 13-14 * * *",
        tags=["opcom", "day_ahead"],
    )
    deploy_flow(
        entrypoint="clients/omie/endpoints/day_ahead.py:run",
        cron="*/15 13-14 * * *",
        tags=["omie", "day_ahead"],
    )
    deploy_flow(
        entrypoint="clients/okte/endpoints/day_ahead.py:run",
        cron="*/15 13-14 * * *",
        tags=["okte", "day_ahead"],
    )
    deploy_flow(
        entrypoint="clients/enex/endpoints/day_ahead.py:run",
        cron="*/15 13-14 * * *",
        tags=["enex", "day_ahead"],
    )

    # EPEX intraday IDA2
    deploy_flow(
        entrypoint="clients/epex/endpoints/ida2.py:run",
        cron="5,20,35,50 10-11 * * *",
        tags=["epex", "intraday", "ida2"],
    )

    # EPEX intraday VWAP
    deploy_flow(
        entrypoint="clients/epex/endpoints/vwap.py:run",
        cron="5,20,35,50 0-3 * * *",
        tags=["epex", "intraday", "vwap"],
    )

    # Monitoring
    deploy_flow(
        entrypoint="monitoring/day_ahead_completeness.py:run",
        cron="0 17 * * *",
        tags=["monitoring"],
    )


if __name__ == "__main__":
    import asyncio

    asyncio.run(remove_deployments())
    deploy_all()
