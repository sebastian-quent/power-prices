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
from typing import List

from prefect import flow
from prefect.client.orchestration import get_client
from prefect.schedules import Cron

WORK_POOL_NAME = "power-prices"
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def deploy_flow(entrypoint: str, crons: List[str], tags: List[str]) -> str:
    # every endpoint's flow function is named run()/run_gb()/run_ie() - keying the
    # deployment name off the function name alone collides across files, so use the
    # full module path instead (still derived here, no per-file @flow(name=...) needed)
    module_path, func_name = entrypoint.split(":")
    name = f"{module_path.removesuffix('.py').replace('/', '-')}-{func_name}"

    flow_instance = flow.from_source(
        source=REPO_ROOT,
        entrypoint=entrypoint,
    )

    flow_instance.deploy(
        name=name,
        work_pool_name=WORK_POOL_NAME,
        schedules=[Cron(cron, timezone="Europe/Copenhagen") for cron in crons],
        tags=tags,
        ignore_warnings=True,
    )
    return name


async def remove_stale_deployments(current_names: set):
    """Removes deployments on this pool whose entrypoint no longer exists.

    Runs after deploy_all() has already re-registered every current flow, so a failed
    deploy_flow() call can't leave a flow with no deployment at all - flow.deploy() upserts
    by name, so re-registration alone is enough to pick up entrypoint/schedule changes.
    Scoped to WORK_POOL_NAME only - never touches Production/Algos' 'prod'/'algos'
    pool deployments.
    """
    async with get_client() as client:
        deployments = await client.read_deployments()
        for deployment in deployments:
            if deployment.work_pool_name == WORK_POOL_NAME and deployment.name not in current_names:
                print(f"Deleting stale deployment: {deployment.name}")
                await client.delete_deployment(deployment.id)


def deploy_all() -> set:
    names = set()

    # Nordpool
    names.add(deploy_flow(
        entrypoint="clients/nordpool/endpoints/day_ahead.py:run",
        crons=["*/15 13-14 * * *"],
        tags=["nordpool", "day_ahead"],
    ))
    names.add(deploy_flow(
        entrypoint="clients/nordpool/endpoints/day_ahead_gb.py:run",
        crons=["*/15 11-12 * * *", "*/15 15-16 * * *"],
        tags=["nordpool", "day_ahead", "gb"],
    ))

    # EPEX
    names.add(deploy_flow(
        entrypoint="clients/epex/endpoints/day_ahead.py:run",
        crons=["*/15 13-14 * * *"],
        tags=["epex", "day_ahead"],
    ))
    names.add(deploy_flow(
        entrypoint="clients/epex/endpoints/day_ahead.py:run_gb",
        crons=["*/15 11-12 * * *", "*/15 15-16 * * *"],
        tags=["epex", "day_ahead", "gb"],
    ))

    # ENTSO-E
    names.add(deploy_flow(
        entrypoint="clients/entsoe/endpoints/day_ahead.py:run",
        crons=["*/15 13-14 * * *"],
        tags=["entsoe", "day_ahead"],
    ))
    names.add(deploy_flow(
        entrypoint="clients/entsoe/endpoints/day_ahead.py:run_ie",
        crons=["*/15 12-13 * * *"],
        tags=["entsoe", "day_ahead", "ie"],
    ))

    # Single-zone local sources
    names.add(deploy_flow(
        entrypoint="clients/ote/endpoints/day_ahead.py:run",
        crons=["*/15 13-14 * * *"],
        tags=["ote", "day_ahead"],
    ))
    names.add(deploy_flow(
        entrypoint="clients/semo/endpoints/day_ahead.py:run",
        crons=["5,20,35,50 1-2 * * *"],
        tags=["semo", "day_ahead"],
    ))
    names.add(deploy_flow(
        entrypoint="clients/opcom/endpoints/day_ahead.py:run",
        crons=["*/15 13-14 * * *"],
        tags=["opcom", "day_ahead"],
    ))
    names.add(deploy_flow(
        entrypoint="clients/omie/endpoints/day_ahead.py:run",
        crons=["*/15 13-14 * * *"],
        tags=["omie", "day_ahead"],
    ))
    names.add(deploy_flow(
        entrypoint="clients/okte/endpoints/day_ahead.py:run",
        crons=["*/15 13-14 * * *"],
        tags=["okte", "day_ahead"],
    ))
    names.add(deploy_flow(
        entrypoint="clients/enex/endpoints/day_ahead.py:run",
        crons=["*/15 13-14 * * *"],
        tags=["enex", "day_ahead"],
    ))

    # EPEX intraday IDA2
    names.add(deploy_flow(
        entrypoint="clients/epex/endpoints/ida2.py:run",
        crons=["5,20,35,50 22-23 * * *"],
        tags=["epex", "intraday", "ida2"],
    ))

    # EPEX intraday VWAP
    names.add(deploy_flow(
        entrypoint="clients/epex/endpoints/vwap.py:run",
        crons=["5,20,35,50 0-3 * * *"],
        tags=["epex", "intraday", "vwap"],
    ))

    # Monitoring
    names.add(deploy_flow(
        entrypoint="monitoring/completeness.py:run",
        crons=["0 17 * * *"],
        tags=["monitoring"],
    ))

    return names


if __name__ == "__main__":
    import asyncio

    current_names = deploy_all()
    asyncio.run(remove_stale_deployments(current_names))
