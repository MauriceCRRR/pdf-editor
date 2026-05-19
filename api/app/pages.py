from __future__ import annotations

import logging
import os
import tempfile
from pathlib import Path

import pymupdf

from app import storage

logger = logging.getLogger(__name__)

_MAX_DIMENSION_PT = 14400.0


def _atomic_save(doc: pymupdf.Document, pdf_file: Path) -> None:
    tmp_fd, tmp_path = tempfile.mkstemp(suffix=".pdf", dir=str(pdf_file.parent))
    os.close(tmp_fd)
    try:
        doc.save(tmp_path, deflate=True, garbage=4, clean=True)
    except Exception:
        Path(tmp_path).unlink(missing_ok=True)
        raise
    os.replace(tmp_path, str(pdf_file))


def add_page(
    document_id: str, at_index: int, width_pt: float, height_pt: float
) -> None:
    pdf_file = storage.pdf_path(document_id)
    if not pdf_file.exists():
        raise FileNotFoundError(str(pdf_file))
    if width_pt <= 0 or height_pt <= 0:
        raise ValueError("page dimensions must be positive")
    if width_pt > _MAX_DIMENSION_PT or height_pt > _MAX_DIMENSION_PT:
        raise ValueError(f"page dimensions must not exceed {int(_MAX_DIMENSION_PT)} pt")

    doc = pymupdf.open(str(pdf_file))
    try:
        page_count = doc.page_count
        if at_index < 0 or at_index > page_count:
            raise ValueError(
                f"atIndex {at_index} out of range [0, {page_count}]"
            )
        pno = -1 if at_index == page_count else at_index
        doc.new_page(pno=pno, width=width_pt, height=height_pt)
        _atomic_save(doc, pdf_file)
    finally:
        doc.close()


def delete_page(document_id: str, index: int) -> None:
    pdf_file = storage.pdf_path(document_id)
    if not pdf_file.exists():
        raise FileNotFoundError(str(pdf_file))

    doc = pymupdf.open(str(pdf_file))
    try:
        page_count = doc.page_count
        if index < 0 or index >= page_count:
            raise ValueError(f"index {index} out of range [0, {page_count - 1}]")
        if page_count <= 1:
            raise ValueError("cannot delete the last remaining page")
        doc.delete_page(index)
        _atomic_save(doc, pdf_file)
    finally:
        doc.close()


def reorder_pages(document_id: str, order: list[int]) -> None:
    pdf_file = storage.pdf_path(document_id)
    if not pdf_file.exists():
        raise FileNotFoundError(str(pdf_file))

    doc = pymupdf.open(str(pdf_file))
    try:
        page_count = doc.page_count
        if len(order) != page_count:
            raise ValueError(
                f"order length {len(order)} does not match pageCount {page_count}"
            )
        if sorted(order) != list(range(page_count)):
            raise ValueError(
                f"order must be a permutation of [0..{page_count - 1}]"
            )
        doc.select(order)
        _atomic_save(doc, pdf_file)
    finally:
        doc.close()
