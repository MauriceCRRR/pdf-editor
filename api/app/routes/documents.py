from __future__ import annotations

import json
import logging
import re
from uuid import uuid4

import aiofiles
import pymupdf
from fastapi import APIRouter, HTTPException, UploadFile, status
from fastapi.responses import FileResponse

from app import storage
from app.models import DocumentMetadata, ImageUploadResponse

logger = logging.getLogger(__name__)

router = APIRouter()

_FILENAME_RE = re.compile(r"^[a-zA-Z0-9._-]+$")
_FONT_CONTENT_TYPES = {
    ".woff2": "font/woff2",
    ".woff": "font/woff",
    ".ttf": "font/ttf",
    ".otf": "font/otf",
}
_IMAGE_EXT_BY_CONTENT_TYPE = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
}
_IMAGE_CONTENT_TYPES = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
}
_IMAGE_MAX_BYTES = 25 * 1024 * 1024
_IMAGE_CHUNK = 1024 * 1024


def _validate_id_or_400(document_id: str) -> None:
    try:
        storage.validate_document_id(document_id)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid document id.",
        ) from exc


@router.get(
    "/doc/{document_id}",
    response_model=DocumentMetadata,
)
async def get_document(document_id: str) -> DocumentMetadata:
    _validate_id_or_400(document_id)

    doc_file = storage.document_path(document_id)
    if not doc_file.exists():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Document not found.",
        )
    async with aiofiles.open(doc_file, "r") as fh:
        raw = await fh.read()
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Corrupted document data.",
        ) from exc

    return DocumentMetadata.model_validate(data)


@router.api_route("/doc/{document_id}/pdf", methods=["GET", "HEAD"])
async def get_document_pdf(document_id: str) -> FileResponse:
    _validate_id_or_400(document_id)

    pdf_file = storage.pdf_path(document_id)
    if not pdf_file.exists():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Document not found.",
        )
    return FileResponse(
        path=pdf_file,
        media_type="application/pdf",
        filename="original.pdf",
    )


@router.api_route("/doc/{document_id}/fonts/{filename}", methods=["GET", "HEAD"])
async def get_document_font(document_id: str, filename: str) -> FileResponse:
    _validate_id_or_400(document_id)

    if not _FILENAME_RE.match(filename):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid font filename.",
        )

    fonts_root = storage.fonts_dir(document_id).resolve()
    font_file = (fonts_root / filename).resolve()
    try:
        font_file.relative_to(fonts_root)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid font filename.",
        ) from exc
    if not font_file.exists() or not font_file.is_file():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Font not found.",
        )

    ext = font_file.suffix.lower()
    media_type = _FONT_CONTENT_TYPES.get(ext, "application/octet-stream")

    # Master files share a single `{ref}-master.<ext>` path but the underlying
    # master mapping can change as the fontlib improves. Don't mark them
    # immutable. Subset files (no `-master.`) are content-stable per ref.
    is_master = "-master." in font_file.name
    cache_value = (
        "public, max-age=300" if is_master else "public, max-age=31536000, immutable"
    )

    return FileResponse(
        path=font_file,
        media_type=media_type,
        headers={"Cache-Control": cache_value},
    )


@router.post("/doc/{document_id}/images", response_model=ImageUploadResponse)
async def upload_image(document_id: str, file: UploadFile) -> ImageUploadResponse:
    _validate_id_or_400(document_id)

    if not storage.pdf_path(document_id).exists():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Document not found.",
        )

    content_type = (file.content_type or "").lower()
    if not content_type.startswith("image/"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="File must be an image.",
        )

    ext = _IMAGE_EXT_BY_CONTENT_TYPE.get(content_type)
    if ext is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Unsupported image type. Allowed: png, jpeg, gif, webp.",
        )

    image_ref = f"{uuid4().hex}{ext}"
    images_root = storage.images_dir(document_id)
    images_root.mkdir(parents=True, exist_ok=True)
    target = images_root / image_ref

    total = 0
    try:
        async with aiofiles.open(target, "wb") as out:
            while True:
                chunk = await file.read(_IMAGE_CHUNK)
                if not chunk:
                    break
                total += len(chunk)
                if total > _IMAGE_MAX_BYTES:
                    target.unlink(missing_ok=True)
                    raise HTTPException(
                        status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                        detail="Image exceeds 25 MB limit.",
                    )
                await out.write(chunk)
    except HTTPException:
        raise
    except Exception:
        target.unlink(missing_ok=True)
        raise

    try:
        pix = pymupdf.Pixmap(str(target))
        width_px = int(pix.width)
        height_px = int(pix.height)
        pix = None
    except Exception as exc:
        target.unlink(missing_ok=True)
        logger.warning("Image decode failed for %s: %s", target, exc)
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Could not decode image.",
        ) from exc

    return ImageUploadResponse(
        imageRef=image_ref,
        url=f"/api/doc/{document_id}/images/{image_ref}",
        widthPx=width_px,
        heightPx=height_px,
    )


@router.api_route("/doc/{document_id}/images/{filename}", methods=["GET", "HEAD"])
async def get_document_image(document_id: str, filename: str) -> FileResponse:
    _validate_id_or_400(document_id)

    if not _FILENAME_RE.match(filename):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid image filename.",
        )

    images_root = storage.images_dir(document_id).resolve()
    image_file = (images_root / filename).resolve()
    try:
        image_file.relative_to(images_root)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid image filename.",
        ) from exc
    if not image_file.exists() or not image_file.is_file():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Image not found.",
        )

    ext = image_file.suffix.lower()
    media_type = _IMAGE_CONTENT_TYPES.get(ext, "application/octet-stream")

    return FileResponse(
        path=image_file,
        media_type=media_type,
        headers={"Cache-Control": "public, max-age=31536000, immutable"},
    )
