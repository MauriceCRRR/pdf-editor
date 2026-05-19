from __future__ import annotations

import asyncio
import re
from pathlib import Path

from filelock import FileLock

STORAGE_ROOT = Path(__file__).parent.parent.parent / "storage"

_DOCUMENT_ID_RE = re.compile(
    r"^[a-f0-9]{32}$|^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
)

_locks: dict[str, asyncio.Lock] = {}
_locks_guard = asyncio.Lock()

LOCK_TIMEOUT_SECONDS = 5.0


def validate_document_id(document_id: str) -> None:
    if not _DOCUMENT_ID_RE.match(document_id):
        raise ValueError(f"Invalid document id: {document_id!r}")


async def document_lock(document_id: str) -> asyncio.Lock:
    async with _locks_guard:
        lock = _locks.get(document_id)
        if lock is None:
            lock = asyncio.Lock()
            _locks[document_id] = lock
        return lock


def doc_dir(document_id: str) -> Path:
    return STORAGE_ROOT / document_id


def pdf_path(document_id: str) -> Path:
    return doc_dir(document_id) / "original.pdf"


def meta_path(document_id: str) -> Path:
    return doc_dir(document_id) / "meta.json"


def document_path(document_id: str) -> Path:
    return doc_dir(document_id) / "document.json"


def fonts_dir(document_id: str) -> Path:
    return doc_dir(document_id) / "fonts"


def images_dir(document_id: str) -> Path:
    return doc_dir(document_id) / "images"


def ensure_storage_root() -> None:
    STORAGE_ROOT.mkdir(parents=True, exist_ok=True)


def document_filelock(document_id: str) -> FileLock:
    """Cross-process advisory lock guarding a single document's save path.

    Pair with the in-process ``document_lock`` ``asyncio.Lock`` to protect
    against multi-worker deployments. The lock file lives inside the
    per-document directory so each document gets its own lock.
    """
    doc = doc_dir(document_id)
    doc.mkdir(parents=True, exist_ok=True)
    return FileLock(str(doc / ".save.lock"), timeout=LOCK_TIMEOUT_SECONDS)
