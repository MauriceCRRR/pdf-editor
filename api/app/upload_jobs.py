"""In-memory upload job registry for SSE progress streaming.

A single FastAPI worker keeps a dict of pending uploads keyed by jobId.
Each job owns an asyncio.Queue the background extractor pushes progress
events into; the SSE endpoint drains the queue and emits events until
either ``done`` or ``error`` is observed, then removes the job. The
registry is intentionally process-local — multi-worker deployments should
either pin clients to a worker (sticky session / single-worker dev mode)
or replace this with a Redis-backed queue.
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from dataclasses import dataclass, field
from typing import Any

logger = logging.getLogger(__name__)


@dataclass
class UploadJob:
    queue: asyncio.Queue[dict[str, Any]] = field(default_factory=asyncio.Queue)
    document_id: str | None = None
    error: str | None = None
    started_at: float = 0.0


_JOBS: dict[str, UploadJob] = {}


def create_job() -> tuple[str, UploadJob]:
    """Create and register a new job. Returns (jobId, job)."""
    job_id = uuid.uuid4().hex
    job = UploadJob()
    _JOBS[job_id] = job
    return job_id, job


def get_job(job_id: str) -> UploadJob | None:
    return _JOBS.get(job_id)


def remove_job(job_id: str) -> None:
    _JOBS.pop(job_id, None)
