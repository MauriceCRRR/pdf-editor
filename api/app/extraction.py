from __future__ import annotations

import logging
import math
from pathlib import Path
from typing import Any, Callable

import pymupdf

from app.fonts import extract_fonts

logger = logging.getLogger(__name__)


class EncryptedPdfError(Exception):
    """Raised when an uploaded PDF requires a password we cannot supply."""


_BOLD_FLAG = 1 << 4
_ITALIC_FLAG = 1 << 1

INVISIBLE_RATIO_THRESHOLD = 0.8
IMAGE_RATIO_THRESHOLD = 0.5

# PyMuPDF widget.field_type integer values; map to the discriminated enum
# we expose on Fragment.formFieldType.
_WIDGET_TYPE_MAP: dict[int, str] = {
    0: "button",
    1: "checkbox",
    2: "combobox",
    3: "listbox",
    4: "radio",
    5: "signature",
    6: "text",
}


def _detect_ocr_layer(page: Any) -> dict[str, Any]:
    """Detect whether a page is mostly a scanned image with invisible OCR text.

    Heuristic: render mode 3 in the text trace marks "neither fill nor stroke"
    (the standard rendering mode used to add invisible OCR text on top of a
    scanned image). If more than 80% of glyphs are invisible AND more than 50%
    of the page area is covered by image blocks, treat the page as scanned.
    """
    try:
        trace = page.get_texttrace()
    except Exception as exc:
        logger.debug("get_texttrace failed: %s", exc)
        return {"appearsScanned": False, "invisibleTextRatio": 0.0, "imageCoverageRatio": 0.0}
    total = len(trace)
    invisible = sum(1 for t in trace if int(t.get("type", 0)) == 3)
    page_area = float(page.rect.width) * float(page.rect.height)
    try:
        raw = page.get_text("rawdict")
    except Exception:
        raw = {"blocks": []}
    image_area = 0.0
    for block in raw.get("blocks", []):
        if block.get("type") == 1:
            bbox = block.get("bbox", [0, 0, 0, 0])
            x0, y0, x1, y1 = bbox[0], bbox[1], bbox[2], bbox[3]
            image_area += max(0.0, float(x1) - float(x0)) * max(
                0.0, float(y1) - float(y0)
            )
    inv_ratio = (invisible / total) if total else 0.0
    img_ratio = (image_area / page_area) if page_area else 0.0
    return {
        "appearsScanned": inv_ratio > INVISIBLE_RATIO_THRESHOLD
        and img_ratio > IMAGE_RATIO_THRESHOLD,
        "invisibleTextRatio": round(inv_ratio, 3),
        "imageCoverageRatio": round(img_ratio, 3),
    }


def _annotate_form_fields(fragments: list[dict[str, Any]], page: Any) -> None:
    """Tag fragments that fall inside an AcroForm widget as read-only.

    The actual rendering is left to the front-end (chip + interactive=false).
    """
    try:
        widgets = list(page.widgets() or [])
    except Exception as exc:
        logger.debug("page.widgets() failed: %s", exc)
        return
    if not widgets:
        return
    for frag in fragments:
        bbox = frag.get("bbox", [0, 0, 0, 0])
        x0, y0, x1, y1 = bbox[0], bbox[1], bbox[2], bbox[3]
        cx = (x0 + x1) / 2.0
        cy = (y0 + y1) / 2.0
        for w in widgets:
            wr = getattr(w, "rect", None)
            if wr is None:
                continue
            if wr.x0 <= cx <= wr.x1 and wr.y0 <= cy <= wr.y1:
                frag["isFormField"] = True
                ft = getattr(w, "field_type", 6)
                try:
                    frag["formFieldType"] = _WIDGET_TYPE_MAP.get(int(ft), "text")
                except (TypeError, ValueError):
                    frag["formFieldType"] = "text"
                fname = getattr(w, "field_name", None)
                frag["formFieldName"] = fname[:64] if fname else None
                break


def _annotate_xobject_fragments(fragments: list[dict[str, Any]], page: Any) -> None:
    """Tag fragments fully contained within a shared XObject placement.

    PyMuPDF 1.23+ returns ``(xref, name, invoker_xref, bbox, transform)``.
    Older versions may return tuples with different shapes; we read bbox via
    index lookup or ``bbox`` attribute and skip otherwise.
    """
    try:
        xobjects = list(page.get_xobjects() or [])
    except Exception as exc:
        logger.debug("page.get_xobjects() failed: %s", exc)
        return
    page_area = float(page.rect.width) * float(page.rect.height)
    rects: list[tuple[float, float, float, float]] = []
    for entry in xobjects:
        try:
            bbox = None
            if isinstance(entry, (list, tuple)) and len(entry) > 3:
                bbox = entry[3]
            if bbox is None:
                bbox = getattr(entry, "bbox", None)
            if bbox is None:
                continue
            x0, y0, x1, y1 = float(bbox[0]), float(bbox[1]), float(bbox[2]), float(bbox[3])
            area = (x1 - x0) * (y1 - y0)
            if 0 < area < 0.9 * page_area:
                rects.append((x0, y0, x1, y1))
        except Exception:
            continue
    if not rects:
        return
    for frag in fragments:
        bbox = frag.get("bbox", [0, 0, 0, 0])
        fx0, fy0, fx1, fy1 = bbox[0], bbox[1], bbox[2], bbox[3]
        for (x0, y0, x1, y1) in rects:
            if x0 <= fx0 and y0 <= fy0 and x1 >= fx1 and y1 >= fy1:
                frag["isFromXObject"] = True
                break


def _line_rotation_deg(line: dict[str, Any]) -> float:
    """Recover a line's text rotation in degrees from PyMuPDF rawdict.

    PyMuPDF rawdict provides ``dir = (cos θ, -sin θ)`` for each line; we
    convert it to degrees, snap to the nearest multiple of 90° within 0.5°
    (since horizontal/quarter-turn rotations dominate real PDFs), and
    otherwise return the raw angle rounded to two decimals.
    """
    try:
        d = line.get("dir") or (1.0, 0.0)
        cx, csy = float(d[0]), float(d[1])
    except Exception:
        return 0.0
    ang = math.degrees(math.atan2(-csy, cx))
    norm = ang % 360
    for snap in (0, 90, 180, 270):
        if abs(((norm - snap + 540) % 360) - 180) < 0.5:
            return float(snap)
    return round(norm, 2)


def _line_writing_mode(line: dict[str, Any]) -> str:
    """Map PyMuPDF ``wmode`` (0=horizontal, 1=vertical) to a CSS value."""
    try:
        wmode = int(line.get("wmode", 0) or 0)
    except Exception:
        return "horizontal-tb"
    return "vertical-rl" if wmode == 1 else "horizontal-tb"


def _unpack_color(c: int) -> list[float]:
    r = (c >> 16) & 0xFF
    g = (c >> 8) & 0xFF
    b = c & 0xFF
    return [round(r / 255, 4), round(g / 255, 4), round(b / 255, 4)]


def _span_text(span: dict[str, Any]) -> str:
    if "text" in span and span["text"] is not None:
        return span["text"]
    return "".join((ch.get("c", "") or "") for ch in span.get("chars", []))


def _span_to_dict(span: dict[str, Any], psname_to_ref: dict[str, str]) -> dict[str, Any]:
    font_ps_name = span.get("font", "") or ""
    flags = int(span.get("flags", 0) or 0)
    lower = font_ps_name.lower()
    bold = bool(flags & _BOLD_FLAG) or ("bold" in lower)
    italic = bool(flags & _ITALIC_FLAG) or ("italic" in lower) or ("oblique" in lower)
    return {
        "text": _span_text(span),
        "fontPsName": font_ps_name,
        "fontRef": psname_to_ref.get(font_ps_name),
        "size": float(span.get("size", 0.0) or 0.0),
        "colorRgb": _unpack_color(int(span.get("color", 0) or 0)),
        "bold": bold,
        "italic": italic,
    }


def _line_text(line: dict[str, Any]) -> str:
    return "".join(_span_text(span) for span in line.get("spans", []))


def _extract_page(
    page: Any, page_index: int, psname_to_ref: dict[str, str]
) -> dict[str, Any]:
    raw = page.get_text("rawdict")
    fragments: list[dict[str, Any]] = []
    counter = 0
    for block in raw.get("blocks", []):
        if block.get("type", 1) != 0:
            continue
        for line in block.get("lines", []):
            text = _line_text(line)
            if not text or text.strip() == "":
                continue
            bbox = line.get("bbox", [0.0, 0.0, 0.0, 0.0])
            fragments.append(
                {
                    "id": f"p{page_index}-f{counter}",
                    "bbox": [float(v) for v in bbox],
                    "text": text,
                    "spans": [_span_to_dict(span, psname_to_ref) for span in line.get("spans", [])],
                    "rotation": _line_rotation_deg(line),
                    "writingMode": _line_writing_mode(line),
                    "isFormField": False,
                    "formFieldType": None,
                    "formFieldName": None,
                    "isFromXObject": False,
                }
            )
            counter += 1

    _annotate_form_fields(fragments, page)
    _annotate_xobject_fragments(fragments, page)
    ocr = _detect_ocr_layer(page)

    return {
        "index": page_index,
        "widthPt": float(page.rect.width),
        "heightPt": float(page.rect.height),
        "rotation": int(page.rotation),
        "fragments": fragments,
        "appearsScanned": ocr["appearsScanned"],
        "invisibleTextRatio": ocr["invisibleTextRatio"],
        "imageCoverageRatio": ocr["imageCoverageRatio"],
    }


def extract_document(
    pdf_path: Path,
    document_id: str,
    filename: str,
    progress: Callable[[str, int, int], None] | None = None,
) -> dict[str, Any]:
    """Extract metadata from a PDF.

    Optional ``progress(phase, done, total)`` callback is invoked at the
    "fonts" and "pages" milestones; safe to pass ``None`` for non-streaming
    callers.
    """
    doc = pymupdf.open(str(pdf_path))
    try:
        if doc.needs_pass or doc.is_encrypted:
            # Common case: PDFs encrypted owner-only accept an empty user password.
            if not doc.authenticate(""):
                raise EncryptedPdfError(
                    "This PDF is password-protected. Please remove the password before uploading."
                )
        page_count = doc.page_count
        if progress is not None:
            try:
                progress("fonts", 0, 1)
            except Exception as exc:
                logger.debug("progress callback raised (fonts:start): %s", exc)
        fonts, psname_to_ref = extract_fonts(doc, document_id)
        if progress is not None:
            try:
                progress("fonts", 1, 1)
            except Exception as exc:
                logger.debug("progress callback raised (fonts:done): %s", exc)
        pages: list[dict[str, Any]] = []
        for idx, page in enumerate(doc):
            pages.append(_extract_page(page, idx, psname_to_ref))
            if progress is not None:
                try:
                    progress("pages", idx + 1, page_count)
                except Exception as exc:
                    logger.debug("progress callback raised (pages:%d): %s", idx, exc)
    finally:
        doc.close()

    return {
        "documentId": document_id,
        "filename": filename,
        "pageCount": page_count,
        "fonts": fonts,
        "pages": pages,
    }
