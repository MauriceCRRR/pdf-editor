from __future__ import annotations

import asyncio
import json
import logging
import os
import tempfile
from pathlib import Path

import aiofiles
from fastapi import APIRouter, HTTPException, status
from filelock import Timeout

from app import storage
from app.extraction import extract_document
from app.models import DocumentMetadata, SaveRequest, SaveResponse, SaveWarning
from app.save import apply_save

logger = logging.getLogger(__name__)

router = APIRouter()


# Strategy: apply_save writes to a tempfile but does NOT replace original.
# We re-extract metadata from the tempfile and persist document.json
# atomically; only then do we os.replace the original PDF. If extraction or
# the sidecar write fails, the original PDF and document.json stay untouched.
@router.post("/doc/{document_id}/save")
async def save_document(document_id: str, payload: SaveRequest) -> SaveResponse:
    try:
        storage.validate_document_id(document_id)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid document id.",
        ) from exc

    pdf_file = storage.pdf_path(document_id)
    if not pdf_file.exists():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Document not found.",
        )

    meta_file = storage.meta_path(document_id)
    filename = ""
    if meta_file.exists():
        try:
            meta = json.loads(meta_file.read_text())
            filename = meta.get("filename", "") or ""
        except Exception:
            filename = ""

    asyncio_lock = await storage.document_lock(document_id)
    async with asyncio_lock:
        # Cross-process file lock: protects multi-worker deployments.
        file_lock = storage.document_filelock(document_id)
        try:
            await asyncio.to_thread(file_lock.acquire)
        except Timeout as exc:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Document is being saved by another process.",
            ) from exc

        try:
            try:
                tmp_pdf_path, warnings_raw = await asyncio.to_thread(
                    apply_save, document_id, payload.edits, payload.insertions
                )
            except ValueError as exc:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=str(exc),
                ) from exc
            except Exception as exc:
                logger.exception("Save failed for %s: %s", document_id, exc)
                raise HTTPException(
                    status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                    detail="Failed to apply edits.",
                ) from exc

            try:
                try:
                    document = await asyncio.to_thread(
                        extract_document, Path(tmp_pdf_path), document_id, filename
                    )
                except Exception as exc:
                    logger.exception("Re-extraction failed for %s: %s", document_id, exc)
                    raise HTTPException(
                        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                        detail="Failed to re-extract document.",
                    ) from exc

                # Atomically write document.json via temp + replace.
                doc_json_target = storage.document_path(document_id)
                try:
                    tmp_json_fd, tmp_json_path = tempfile.mkstemp(
                        suffix=".json", dir=str(doc_json_target.parent)
                    )
                    os.close(tmp_json_fd)
                    async with aiofiles.open(tmp_json_path, "w") as fh:
                        await fh.write(json.dumps(document, indent=2, ensure_ascii=False))
                    os.replace(tmp_json_path, str(doc_json_target))
                except Exception as exc:
                    logger.exception(
                        "document.json persist failed for %s: %s", document_id, exc
                    )
                    # best-effort cleanup of partial json tempfile
                    try:
                        Path(tmp_json_path).unlink(missing_ok=True)  # type: ignore[name-defined]
                    except Exception:
                        pass
                    raise HTTPException(
                        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                        detail="Failed to persist document metadata.",
                    ) from exc

                # All sidecars are good — now finalize the PDF swap.
                os.replace(tmp_pdf_path, str(pdf_file))
            except HTTPException:
                # On any failure after apply_save, drop the tempfile so the
                # original PDF remains the source of truth.
                Path(tmp_pdf_path).unlink(missing_ok=True)
                raise
        finally:
            try:
                file_lock.release()
            except Exception:
                logger.debug("file_lock release failed (already released?)")

    return SaveResponse(
        document=DocumentMetadata.model_validate(document),
        warnings=[SaveWarning(**w) for w in warnings_raw],
    )
