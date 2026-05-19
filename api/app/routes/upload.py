from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

import aiofiles
from fastapi import APIRouter, BackgroundTasks, File, HTTPException, UploadFile, status
from fastapi.responses import StreamingResponse

from app import storage, upload_jobs
from app.extraction import EncryptedPdfError, extract_document
from app.models import UploadResponse

logger = logging.getLogger(__name__)

router = APIRouter()

MAX_BYTES = 50 * 1024 * 1024
CHUNK_SIZE = 1024 * 1024
ALLOWED_CONTENT_TYPES = {"application/pdf"}


def _validate_pdf_upload(file: UploadFile) -> None:
    filename = file.filename or ""
    content_type = (file.content_type or "").lower()
    is_pdf_content = content_type in ALLOWED_CONTENT_TYPES
    is_pdf_ext = filename.lower().endswith(".pdf")
    if not (is_pdf_content or is_pdf_ext):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Only PDF uploads are accepted.",
        )


async def _stream_to_disk(file: UploadFile, doc_directory: Path, pdf_target: Path) -> int:
    total_bytes = 0
    async with aiofiles.open(pdf_target, "wb") as out:
        while True:
            chunk = await file.read(CHUNK_SIZE)
            if not chunk:
                break
            total_bytes += len(chunk)
            if total_bytes > MAX_BYTES:
                pdf_target.unlink(missing_ok=True)
                try:
                    doc_directory.rmdir()
                except OSError:
                    pass
                raise HTTPException(
                    status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                    detail="File exceeds 50 MB limit.",
                )
            await out.write(chunk)
    return total_bytes


async def _persist_sidecars(
    document_id: str,
    document: dict,
    filename: str,
    total_bytes: int,
) -> None:
    """Write document.json + meta.json the way the non-streaming endpoint does."""
    async with aiofiles.open(storage.document_path(document_id), "w") as doc_file:
        await doc_file.write(json.dumps(document, indent=2, ensure_ascii=False))
    meta = {
        "filename": filename,
        "uploadedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "sizeBytes": total_bytes,
    }
    async with aiofiles.open(storage.meta_path(document_id), "w") as meta_file:
        await meta_file.write(json.dumps(meta, indent=2))


def _cleanup_failed_upload(pdf_target: Path, doc_directory: Path) -> None:
    pdf_target.unlink(missing_ok=True)
    if doc_directory.exists():
        try:
            doc_directory.rmdir()
        except OSError:
            pass


@router.post("/upload", response_model=UploadResponse, response_model_by_alias=True)
async def upload(file: UploadFile) -> UploadResponse:
    _validate_pdf_upload(file)
    filename = file.filename or ""

    document_id = uuid.uuid4().hex
    storage.ensure_storage_root()
    doc_directory = storage.doc_dir(document_id)
    doc_directory.mkdir(parents=True, exist_ok=True)

    pdf_target = storage.pdf_path(document_id)
    try:
        total_bytes = await _stream_to_disk(file, doc_directory, pdf_target)
    except HTTPException:
        raise
    except Exception:
        _cleanup_failed_upload(pdf_target, doc_directory)
        raise

    try:
        document = await asyncio.to_thread(
            extract_document, pdf_target, document_id, filename
        )
    except EncryptedPdfError as exc:
        _cleanup_failed_upload(pdf_target, doc_directory)
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        ) from exc
    except Exception as exc:
        logger.exception("Extraction failed for %s: %s", document_id, exc)
        _cleanup_failed_upload(pdf_target, doc_directory)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to process PDF. The file may be corrupted or unsupported.",
        ) from exc

    await _persist_sidecars(document_id, document, filename, total_bytes)

    return UploadResponse(
        document_id=document_id,
        page_count=int(document.get("pageCount", 0)),
        filename=filename,
    )


@router.post("/upload/streaming")
async def upload_streaming(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
) -> dict[str, str]:
    """Streaming upload variant.

    Saves bytes synchronously (so 413 / validation errors surface
    immediately), then schedules the heavy extract step on a background
    task and returns a jobId the client can subscribe to via SSE at
    ``GET /api/upload/{jobId}/events``.
    """
    _validate_pdf_upload(file)
    filename = file.filename or ""

    document_id = uuid.uuid4().hex
    storage.ensure_storage_root()
    doc_directory = storage.doc_dir(document_id)
    doc_directory.mkdir(parents=True, exist_ok=True)

    pdf_target = storage.pdf_path(document_id)
    try:
        total_bytes = await _stream_to_disk(file, doc_directory, pdf_target)
    except HTTPException:
        raise
    except Exception:
        _cleanup_failed_upload(pdf_target, doc_directory)
        raise

    job_id, job = upload_jobs.create_job()
    job.document_id = document_id
    job.started_at = time.time()

    background_tasks.add_task(
        _run_extract_with_progress,
        job_id,
        document_id,
        pdf_target,
        doc_directory,
        filename,
        total_bytes,
    )
    return {"jobId": job_id, "documentId": document_id}


async def _run_extract_with_progress(
    job_id: str,
    document_id: str,
    pdf_target: Path,
    doc_directory: Path,
    filename: str,
    total_bytes: int,
) -> None:
    job = upload_jobs.get_job(job_id)
    if job is None:
        return
    loop = asyncio.get_running_loop()

    def progress(phase: str, done: int, total: int) -> None:
        # Called from extraction worker thread; hop back to the loop.
        try:
            loop.call_soon_threadsafe(
                job.queue.put_nowait,
                {"phase": phase, "done": int(done), "total": int(total)},
            )
        except Exception as exc:
            logger.debug("progress put_nowait failed: %s", exc)

    try:
        document = await asyncio.to_thread(
            extract_document, pdf_target, document_id, filename, progress
        )
        await _persist_sidecars(document_id, document, filename, total_bytes)
        await job.queue.put(
            {
                "done": True,
                "documentId": document_id,
                "pageCount": int(document.get("pageCount", 0)),
                "filename": filename,
            }
        )
    except EncryptedPdfError as exc:
        _cleanup_failed_upload(pdf_target, doc_directory)
        job.error = str(exc)
        await job.queue.put({"error": str(exc), "code": "encrypted"})
    except Exception as exc:
        logger.exception("upload-streaming extraction failed: %s", exc)
        _cleanup_failed_upload(pdf_target, doc_directory)
        job.error = str(exc)
        await job.queue.put(
            {
                "error": "Failed to process PDF. The file may be corrupted or unsupported.",
            }
        )


@router.get("/upload/{job_id}/events")
async def upload_events(job_id: str) -> StreamingResponse:
    job = upload_jobs.get_job(job_id)
    if job is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Unknown upload job",
        )

    async def gen():
        try:
            while True:
                evt = await job.queue.get()
                yield f"data: {json.dumps(evt)}\n\n"
                if evt.get("done") or evt.get("error"):
                    break
        finally:
            upload_jobs.remove_job(job_id)

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
        },
    )
