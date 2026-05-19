from __future__ import annotations

import asyncio
import json
import logging
import os
import tempfile
from pathlib import Path

import aiofiles
from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, ConfigDict, Field

from app import storage
from app.extraction import extract_document
from app.models import DocumentMetadata
from app.pages import add_page, delete_page, reorder_pages

logger = logging.getLogger(__name__)

router = APIRouter()


class AddPageRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    atIndex: int = Field(ge=0)
    widthPt: float = Field(default=612.0, gt=0, le=14400)
    heightPt: float = Field(default=792.0, gt=0, le=14400)


class ReorderPagesRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    order: list[int]


def _validate_id_or_400(document_id: str) -> None:
    try:
        storage.validate_document_id(document_id)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid document id.",
        ) from exc


async def _refresh_document(document_id: str) -> DocumentMetadata:
    pdf_file = storage.pdf_path(document_id)
    meta_file = storage.meta_path(document_id)
    filename = ""
    if meta_file.exists():
        try:
            meta = json.loads(meta_file.read_text())
            filename = meta.get("filename", "") or ""
        except Exception:
            filename = ""

    try:
        document = await asyncio.to_thread(
            extract_document, pdf_file, document_id, filename
        )
    except Exception as exc:
        logger.exception("Re-extraction failed for %s: %s", document_id, exc)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to re-extract document.",
        ) from exc

    doc_json_target = storage.document_path(document_id)
    tmp_json_path: str | None = None
    try:
        tmp_json_fd, tmp_json_path = tempfile.mkstemp(
            suffix=".json", dir=str(doc_json_target.parent)
        )
        os.close(tmp_json_fd)
        async with aiofiles.open(tmp_json_path, "w") as fh:
            await fh.write(json.dumps(document, indent=2, ensure_ascii=False))
        os.replace(tmp_json_path, str(doc_json_target))
    except Exception as exc:
        if tmp_json_path is not None:
            Path(tmp_json_path).unlink(missing_ok=True)
        logger.exception("document.json persist failed for %s: %s", document_id, exc)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to persist document metadata.",
        ) from exc

    return DocumentMetadata.model_validate(document)


@router.post("/doc/{document_id}/pages", response_model=DocumentMetadata)
async def add_page_route(
    document_id: str, payload: AddPageRequest
) -> DocumentMetadata:
    _validate_id_or_400(document_id)

    pdf_file = storage.pdf_path(document_id)
    if not pdf_file.exists():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Document not found.",
        )

    lock = await storage.document_lock(document_id)
    async with lock:
        try:
            await asyncio.to_thread(
                add_page, document_id, payload.atIndex, payload.widthPt, payload.heightPt
            )
        except ValueError as exc:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=str(exc),
            ) from exc
        except Exception as exc:
            logger.exception("add_page failed for %s: %s", document_id, exc)
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Failed to add page.",
            ) from exc

        return await _refresh_document(document_id)


@router.post("/doc/{document_id}/pages/reorder", response_model=DocumentMetadata)
async def reorder_pages_route(
    document_id: str, payload: ReorderPagesRequest
) -> DocumentMetadata:
    _validate_id_or_400(document_id)

    pdf_file = storage.pdf_path(document_id)
    if not pdf_file.exists():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Document not found.",
        )

    lock = await storage.document_lock(document_id)
    async with lock:
        try:
            await asyncio.to_thread(reorder_pages, document_id, payload.order)
        except ValueError as exc:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=str(exc),
            ) from exc
        except Exception as exc:
            logger.exception("reorder_pages failed for %s: %s", document_id, exc)
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Failed to reorder pages.",
            ) from exc

        return await _refresh_document(document_id)


@router.delete("/doc/{document_id}/pages/{index}", response_model=DocumentMetadata)
async def delete_page_route(document_id: str, index: int) -> DocumentMetadata:
    _validate_id_or_400(document_id)

    pdf_file = storage.pdf_path(document_id)
    if not pdf_file.exists():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Document not found.",
        )

    lock = await storage.document_lock(document_id)
    async with lock:
        try:
            await asyncio.to_thread(delete_page, document_id, index)
        except ValueError as exc:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=str(exc),
            ) from exc
        except Exception as exc:
            logger.exception("delete_page failed for %s: %s", document_id, exc)
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Failed to delete page.",
            ) from exc

        return await _refresh_document(document_id)
