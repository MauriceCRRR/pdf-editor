from __future__ import annotations

import json
import logging
import math
import os
import tempfile
from collections import defaultdict
from pathlib import Path
from typing import Any

import pymupdf

from app import fontlib, storage
from app.models import (
    EditDelta,
    ImageInsertion,
    Insertion,
    LineInsertion,
    ShapeInsertion,
    SpanDelta,
    TextInsertion,
)

logger = logging.getLogger(__name__)

_BUILTIN_BY_FAMILY = {
    "helvetica": ("helv", "hebo", "heit", "hebi"),
    "arial": ("helv", "hebo", "heit", "hebi"),
    "times": ("tiro", "tibo", "tiit", "tibi"),
    "courier": ("cour", "cobo", "coit", "cobi"),
}

_ALIGN_MAP = {
    "left": 0,
    "center": 1,
    "right": 2,
    "justify": 3,
}


def _builtin_for(base_name: str, bold: bool, italic: bool) -> str:
    lower = (base_name or "").lower()
    variants = None
    for needle, mapping in _BUILTIN_BY_FAMILY.items():
        if needle in lower:
            variants = mapping
            break
    if variants is None:
        variants = _BUILTIN_BY_FAMILY["helvetica"]
    if bold and italic:
        return variants[3]
    if bold:
        return variants[1]
    if italic:
        return variants[2]
    return variants[0]


def _font_base_name(document_id: str, font_ref: str | None) -> str:
    if not font_ref:
        return ""
    doc_file = storage.document_path(document_id)
    if not doc_file.exists():
        return ""
    try:
        data = json.loads(doc_file.read_text())
    except Exception:
        return ""
    for entry in data.get("fonts", []):
        if entry.get("ref") == font_ref:
            return entry.get("baseName") or entry.get("psName") or ""
    return ""


def _source_font_path(document_id: str, font_ref: str | None) -> Path | None:
    if not font_ref:
        return None
    fonts_root = storage.fonts_dir(document_id)
    for ext in ("ttf", "otf"):
        candidate = fonts_root / f"{font_ref}.{ext}"
        if candidate.exists():
            return candidate
    return None


def _master_font_path(document_id: str, font_ref: str | None) -> Path | None:
    if not font_ref:
        return None
    fonts_root = storage.fonts_dir(document_id)
    for ext in ("ttf", "otf"):
        candidate = fonts_root / f"{font_ref}-master.{ext}"
        if candidate.exists():
            return candidate
    return None


def _subset_codepoints(document_id: str, font_ref: str | None) -> set[int]:
    if not font_ref:
        return set()
    doc_file = storage.document_path(document_id)
    if not doc_file.exists():
        return set()
    try:
        data = json.loads(doc_file.read_text())
    except Exception:
        return set()
    for entry in data.get("fonts", []):
        if entry.get("ref") == font_ref:
            return set(entry.get("availableCodepoints") or [])
    return set()


# Whitespace/control codepoints that should not force a master swap.
# PyMuPDF normalizes spaces; a missing space codepoint in the subset shouldn't
# matter at render time.
_WHITESPACE_CODEPOINTS = {0x20, 0x09, 0x0A}


def _text_needs_master(text: str, subset_codepoints: set[int]) -> bool:
    for ch in text:
        cp = ord(ch)
        if cp in _WHITESPACE_CODEPOINTS:
            continue
        if cp not in subset_codepoints:
            return True
    return False


def _register_font(
    page: Any,
    cache_key: str,
    internal_name: str,
    path: Path,
    registered: dict[str, str],
) -> bool:
    """Try to register ``path`` on ``page`` under ``internal_name``.

    On success, stores ``cache_key -> internal_name`` in ``registered`` and
    returns True. On failure, returns False (caller chooses the fallback).
    """
    try:
        page.insert_font(fontname=internal_name, fontfile=str(path))
        registered[cache_key] = internal_name
        return True
    except Exception as exc:
        logger.warning(
            "insert_font failed for %s (%s): %s",
            cache_key,
            path,
            exc,
        )
        return False


def _resolve_edit_fontname(
    page: Any,
    document_id: str,
    edit: EditDelta,
    registered: dict[str, str],
) -> str:
    # Builtin path: no font ref attached to the edit.
    if not edit.fontRef:
        return _builtin_for(_font_base_name(document_id, edit.fontRef), edit.bold, edit.italic)

    subset_cps = _subset_codepoints(document_id, edit.fontRef)
    master_path = _master_font_path(document_id, edit.fontRef)
    source_path = _source_font_path(document_id, edit.fontRef)

    # Decide whether we *must* use the master:
    #  - text contains a non-whitespace codepoint missing from the subset, OR
    #  - the subset codepoints list is empty (e.g. Standard-14 fonts where the
    #    WOFF2 wasn't generated and the master is the source of truth).
    needs_master = _text_needs_master(edit.newText, subset_cps) or not subset_cps

    if needs_master and master_path is not None:
        logger.info(
            "master-swap for %s: text contains codepoints outside subset",
            edit.fontRef,
        )
        cache_key = f"edit-master:{edit.fontRef}"
        if cache_key not in registered:
            internal_name = f"em{edit.fontRef}"
            if not _register_font(page, cache_key, internal_name, master_path, registered):
                # Master registration failed; try subset, then builtin.
                if source_path is not None:
                    sub_key = f"edit:{edit.fontRef}"
                    if sub_key not in registered:
                        sub_internal = f"e{edit.fontRef}"
                        if not _register_font(
                            page, sub_key, sub_internal, source_path, registered
                        ):
                            registered[sub_key] = _builtin_for(
                                _font_base_name(document_id, edit.fontRef),
                                edit.bold,
                                edit.italic,
                            )
                    return registered[sub_key]
                return _builtin_for(
                    _font_base_name(document_id, edit.fontRef), edit.bold, edit.italic
                )
        return registered[cache_key]

    if source_path is not None:
        cache_key = f"edit:{edit.fontRef}"
        if cache_key not in registered:
            internal_name = f"e{edit.fontRef}"
            if not _register_font(page, cache_key, internal_name, source_path, registered):
                registered[cache_key] = _builtin_for(
                    _font_base_name(document_id, edit.fontRef), edit.bold, edit.italic
                )
        return registered[cache_key]

    return _builtin_for(_font_base_name(document_id, edit.fontRef), edit.bold, edit.italic)


def _resolve_span_font(
    page: Any,
    document_id: str,
    span: SpanDelta,
    registered: dict[str, str],
) -> tuple[str, Path | None]:
    """Resolve fontname + a local font file for one SpanDelta.

    Mirrors :func:`_resolve_edit_fontname` but keyed on a span instead of an
    EditDelta. Returns ``(fontname_registered_on_page, font_path_or_None)``.
    The font path is preferred for ``pymupdf.Font`` construction in the
    TextWriter path; ``fontname`` is the fallback for builtins.
    """
    if not span.fontRef:
        name = _builtin_for(_font_base_name(document_id, span.fontRef), span.bold, span.italic)
        return name, None

    subset_cps = _subset_codepoints(document_id, span.fontRef)
    master_path = _master_font_path(document_id, span.fontRef)
    source_path = _source_font_path(document_id, span.fontRef)

    needs_master = _text_needs_master(span.text, subset_cps) or not subset_cps

    if needs_master and master_path is not None:
        cache_key = f"edit-master:{span.fontRef}"
        if cache_key not in registered:
            internal_name = f"em{span.fontRef}"
            if not _register_font(page, cache_key, internal_name, master_path, registered):
                if source_path is not None:
                    sub_key = f"edit:{span.fontRef}"
                    if sub_key not in registered:
                        sub_internal = f"e{span.fontRef}"
                        if not _register_font(
                            page, sub_key, sub_internal, source_path, registered
                        ):
                            registered[sub_key] = _builtin_for(
                                _font_base_name(document_id, span.fontRef),
                                span.bold,
                                span.italic,
                            )
                            return registered[sub_key], None
                    return registered[sub_key], source_path
                name = _builtin_for(
                    _font_base_name(document_id, span.fontRef), span.bold, span.italic
                )
                return name, None
        return registered[cache_key], master_path

    if source_path is not None:
        cache_key = f"edit:{span.fontRef}"
        if cache_key not in registered:
            internal_name = f"e{span.fontRef}"
            if not _register_font(page, cache_key, internal_name, source_path, registered):
                registered[cache_key] = _builtin_for(
                    _font_base_name(document_id, span.fontRef), span.bold, span.italic
                )
                return registered[cache_key], None
        return registered[cache_key], source_path

    name = _builtin_for(_font_base_name(document_id, span.fontRef), span.bold, span.italic)
    return name, None


def _apply_multi_span_edit(
    page: Any,
    document_id: str,
    edit: EditDelta,
    registered: dict[str, str],
    page_index: int,
    warnings: list[dict[str, Any]],
) -> None:
    """Render an edit whose ``newSpans`` has more than one element.

    Uses :class:`pymupdf.TextWriter` so each span keeps its own font, size,
    weight, and colour. Spans flow left-to-right along a shared baseline
    inside ``edit.newBBox``; no automatic wrapping is performed in v1.

    The pen advance per span uses the span's own font for measurement so that
    a bold "$42.00" doesn't overlap or under-shoot the preceding text. Any
    span that pushes past the bbox's right edge produces a ``text_overflow``
    warning, but the spans are still written (the caller's redaction already
    cleared the original glyphs).
    """
    assert edit.newSpans is not None and len(edit.newSpans) > 1

    x0, y0, x1, y1 = edit.newBBox

    # Group spans by colour so each TextWriter can flush a single colour
    # (pymupdf's write_text takes one colour per writer). We retain the
    # original order so caret/positioning is preserved.
    pen_x = x0
    # Baseline within the bbox: PyMuPDF y axis is top-down, baseline sits at
    # roughly y1 - max(descender) * size. Use a conservative heuristic that
    # matches the visual position of insert_textbox for single-span edits.
    # Fonts vary, but `(y1 - descender * size)` keeps the text within the
    # original bbox for typical Latin fonts.
    overflow_emitted = False

    # Each span flushes its own writer so per-span colour is honoured.
    for span in edit.newSpans:
        if not span.text:
            continue
        fontname, font_path = _resolve_span_font(page, document_id, span, registered)
        font: pymupdf.Font
        try:
            if font_path is not None:
                font = pymupdf.Font(fontfile=str(font_path))
            else:
                font = pymupdf.Font(fontname=fontname)
        except Exception as exc:  # pragma: no cover — defensive
            logger.warning(
                "multi-span: pymupdf.Font failed for ref=%s (%s); falling back to builtin",
                span.fontRef,
                exc,
            )
            font = pymupdf.Font(fontname="helv")

        try:
            width = float(font.text_length(span.text, fontsize=span.size))
        except Exception:
            width = _measure_text_width(span.text, fontname, font_path, span.size)

        # Baseline: y1 is the bbox bottom in PyMuPDF coords. The font descender
        # is negative in font units (1.0 = 1 em). Lift the baseline by the
        # descent so glyphs sit inside the bbox.
        try:
            descender = float(font.descender)
        except Exception:
            descender = -0.2
        baseline_y = y1 + descender * span.size

        if pen_x + width > x1 + 0.5 and not overflow_emitted:
            warnings.append(
                {
                    "fragId": edit.fragId,
                    "insertionId": None,
                    "pageIndex": page_index,
                    "code": "text_overflow",
                    "message": (
                        f"Multi-span text overflowed fragment {edit.fragId}; "
                        "widen the box or shrink the font."
                    ),
                }
            )
            overflow_emitted = True

        tw = pymupdf.TextWriter(page.rect)
        try:
            tw.append(
                (pen_x, baseline_y),
                span.text,
                font=font,
                fontsize=span.size,
            )
        except Exception as exc:
            logger.warning(
                "TextWriter.append failed for span (ref=%s): %s", span.fontRef, exc
            )
            continue
        try:
            tw.write_text(page, color=tuple(span.colorRgb))
        except Exception as exc:
            logger.warning(
                "TextWriter.write_text failed for span (ref=%s): %s",
                span.fontRef,
                exc,
            )
            continue

        pen_x += width

        # Per-span underline/strikethrough decorations.
        if span.underline or span.strikethrough:
            _draw_text_decorations(
                page,
                pen_x - width,
                y0,
                pen_x,
                y1,
                span.size,
                tuple(span.colorRgb),
                span.underline,
                span.strikethrough,
                text=span.text,
                fontname=fontname,
                font_path=font_path,
                align="left",
            )


def _fontlib_path_for(font_key: str) -> Path | None:
    lib = fontlib.load_fontlib()
    for entry in lib:
        if entry.get("slug") == font_key:
            return fontlib.master_ttf_path(entry)
    return None


def _resolve_insertion_fontname(
    page: Any,
    ins: TextInsertion,
    registered: dict[str, str],
) -> str:
    cache_key = f"fl:{ins.fontKey}"
    if cache_key in registered:
        return registered[cache_key]

    ttf_path = _fontlib_path_for(ins.fontKey)
    if ttf_path is None or not ttf_path.exists():
        logger.warning("fontlib slug %s not found; using builtin", ins.fontKey)
        name = _builtin_for(ins.fontKey, ins.bold, ins.italic)
        registered[cache_key] = name
        return name

    internal_name = f"i_{ins.fontKey.replace('-', '_')}"
    try:
        page.insert_font(fontname=internal_name, fontfile=str(ttf_path))
        registered[cache_key] = internal_name
    except Exception as exc:
        logger.warning(
            "insert_font failed for fontlib slug %s (%s): %s",
            ins.fontKey,
            ttf_path,
            exc,
        )
        registered[cache_key] = _builtin_for(ins.fontKey, ins.bold, ins.italic)
    return registered[cache_key]


def _measure_text_width(
    text: str,
    fontname: str,
    font_path: Path | None,
    size: float,
) -> float:
    """Measure rendered text width in points using PyMuPDF helpers.

    Falls back to a rough heuristic if neither file-based nor builtin
    measurement succeeds.
    """
    if font_path is not None:
        try:
            font = pymupdf.Font(fontfile=str(font_path))
            return float(font.text_length(text, fontsize=size))
        except Exception as exc:
            logger.debug("pymupdf.Font measurement failed for %s: %s", font_path, exc)
    try:
        return float(pymupdf.get_text_length(text, fontname=fontname, fontsize=size))
    except Exception as exc:
        logger.debug(
            "pymupdf.get_text_length failed for fontname=%s: %s", fontname, exc
        )
    return 0.5 * size * len(text)


def _draw_text_decorations(
    page: Any,
    x0: float,
    y0: float,
    x1: float,
    y1: float,
    size: float,
    color: tuple[float, float, float],
    underline: bool,
    strikethrough: bool,
    text: str = "",
    fontname: str = "",
    font_path: Path | None = None,
    align: str = "left",
) -> None:
    if not (underline or strikethrough):
        return
    line_width = max(0.5, size * 0.05)

    # Multi-line text: fall back to bbox-wide (don't try per-line).
    use_bbox = (not text) or ("\n" in text) or align == "justify"
    if use_bbox:
        lx0, lx1 = x0, x1
    else:
        width = _measure_text_width(text, fontname, font_path, size)
        if width <= 0:
            lx0, lx1 = x0, x1
        elif align == "right":
            lx0 = max(x0, x1 - width)
            lx1 = x1
        elif align == "center":
            mid = (x0 + x1) / 2.0
            half = width / 2.0
            lx0 = max(x0, mid - half)
            lx1 = min(x1, mid + half)
        else:  # left or unknown
            lx0 = x0
            lx1 = min(x1, x0 + width)

    if underline:
        # PyMuPDF uses top-left origin: y1 is the *bottom* edge of the bbox.
        # Place the underline slightly below the bbox so descenders aren't
        # crossed at large font sizes.
        y_under = y1 + max(1.0, size * 0.1)
        page.draw_line((lx0, y_under), (lx1, y_under), color=color, width=line_width)
    if strikethrough:
        y_strike = (y0 + y1) / 2.0
        page.draw_line((lx0, y_strike), (lx1, y_strike), color=color, width=line_width)


def _draw_shape(page: Any, ins: ShapeInsertion) -> None:
    rect = pymupdf.Rect(*ins.bbox)
    stroke = tuple(ins.strokeRgb) if ins.strokeRgb is not None else None
    fill = tuple(ins.fillRgb) if ins.fillRgb is not None else None
    width = ins.strokeWidth if stroke is not None else 0
    if ins.type == "rectangle":
        page.draw_rect(rect, color=stroke, fill=fill, width=width, overlay=True)
    else:
        page.draw_oval(rect, color=stroke, fill=fill, width=width, overlay=True)


def _draw_line_or_arrow(page: Any, ins: LineInsertion) -> None:
    color = tuple(ins.strokeRgb)
    p_from = (ins.fromPt[0], ins.fromPt[1])
    p_to = (ins.toPt[0], ins.toPt[1])
    page.draw_line(p_from, p_to, color=color, width=ins.strokeWidth)
    if ins.type != "arrow":
        return
    dx = p_to[0] - p_from[0]
    dy = p_to[1] - p_from[1]
    angle = math.atan2(dy, dx)
    head_len = max(6.0, ins.strokeWidth * 5)
    head_angle = math.radians(22)
    left = (
        p_to[0] - head_len * math.cos(angle - head_angle),
        p_to[1] - head_len * math.sin(angle - head_angle),
    )
    right = (
        p_to[0] - head_len * math.cos(angle + head_angle),
        p_to[1] - head_len * math.sin(angle + head_angle),
    )
    page.draw_line(p_to, left, color=color, width=ins.strokeWidth)
    page.draw_line(p_to, right, color=color, width=ins.strokeWidth)


def _draw_image(page: Any, ins: ImageInsertion, document_id: str) -> None:
    path = storage.images_dir(document_id) / ins.imageRef
    if not path.exists():
        raise ValueError(f"image '{ins.imageRef}' not found")
    rect = pymupdf.Rect(*ins.bbox)
    page.insert_image(
        rect,
        filename=str(path),
        keep_proportion=True,
        overlay=True,
    )


def _insert_text(
    page: Any,
    document_id: str,
    ins: TextInsertion,
    registered: dict[str, str],
    page_bottom: float,
    page_index: int,
    warnings: list[dict[str, Any]],
) -> None:
    fontname = _resolve_insertion_fontname(page, ins, registered)
    x0, y0, x1, y1 = ins.bbox
    expanded_y1 = min(page_bottom, y0 + max(64.0, (y1 - y0) * 4.0))
    rect = pymupdf.Rect(x0, y0, x1, max(y1, expanded_y1))
    color = tuple(ins.colorRgb)
    align_int = _ALIGN_MAP[ins.align]
    rv = page.insert_textbox(
        rect,
        ins.text,
        fontname=fontname,
        fontsize=ins.size,
        color=color,
        align=align_int,
    )
    try:
        if rv is not None and float(rv) < 0:
            warnings.append(
                {
                    "fragId": None,
                    "insertionId": ins.id,
                    "pageIndex": page_index,
                    "code": "text_overflow",
                    "message": (
                        f"Inserted text didn't fit in box {ins.id}. "
                        "Expand the box or shrink the font."
                    ),
                }
            )
    except (TypeError, ValueError):
        pass
    font_path = _fontlib_path_for(ins.fontKey)
    _draw_text_decorations(
        page,
        x0,
        y0,
        x1,
        y1,
        ins.size,
        color,
        ins.underline,
        ins.strikethrough,
        text=ins.text,
        fontname=fontname,
        font_path=font_path,
        align=ins.align,
    )


def apply_save(
    document_id: str,
    edits: list[EditDelta],
    insertions: list[Insertion],
) -> tuple[str, list[dict[str, Any]]]:
    """Apply edits/insertions and write the result to a tempfile in the doc dir.

    Returns ``(tmp_pdf_path, warnings)``. The caller is responsible for
    atomically replacing the original (e.g. via ``os.replace``) AFTER it has
    successfully re-extracted metadata and persisted ``document.json``. This
    avoids the inconsistent on-disk state where the PDF is updated but the JSON
    sidecar is stale because re-extraction or sidecar write raised.

    ``warnings`` is a list of dicts compatible with the ``SaveWarning`` model.
    """
    pdf_file = storage.pdf_path(document_id)
    if not pdf_file.exists():
        raise FileNotFoundError(str(pdf_file))

    edits_by_page: dict[int, list[EditDelta]] = defaultdict(list)
    for edit in edits:
        edits_by_page[edit.pageIndex].append(edit)

    ins_by_page: dict[int, list[Insertion]] = defaultdict(list)
    for ins in insertions:
        ins_by_page[ins.pageIndex].append(ins)

    page_indexes = sorted(set(edits_by_page.keys()) | set(ins_by_page.keys()))

    warnings: list[dict[str, Any]] = []
    tmp_path: str | None = None
    doc = pymupdf.open(str(pdf_file))
    try:
        for page_index in page_indexes:
            if page_index < 0 or page_index >= doc.page_count:
                raise ValueError(f"pageIndex {page_index} out of range")
            page = doc[page_index]
            page_bottom = float(page.rect.y1)
            page_edits = edits_by_page.get(page_index, [])
            page_ins = ins_by_page.get(page_index, [])

            for edit in page_edits:
                rect = pymupdf.Rect(*edit.originalBBox)
                page.add_redact_annot(rect, fill=(1, 1, 1), cross_out=False)
            if page_edits:
                page.apply_redactions(images=2, graphics=1, text=0)

            registered: dict[str, str] = {}

            for edit in page_edits:
                if not edit.newText:
                    continue
                # Multi-span path: when the edit carries explicit per-span
                # styling (mixed bold/colour/size within a single fragment),
                # render via TextWriter so each span retains its own style.
                # Single-span edits keep the existing insert_textbox path so
                # alignment/wrapping behaviour is unchanged for legacy fragments.
                if edit.newSpans is not None and len(edit.newSpans) > 1:
                    _apply_multi_span_edit(
                        page,
                        document_id,
                        edit,
                        registered,
                        page_index,
                        warnings,
                    )
                    continue
                fontname = _resolve_edit_fontname(page, document_id, edit, registered)
                x0, y0, x1, y1 = edit.newBBox
                expanded_y1 = min(page_bottom, y0 + max(64.0, (y1 - y0) * 4.0))
                rect = pymupdf.Rect(x0, y0, x1, max(y1, expanded_y1))
                color = tuple(edit.colorRgb)
                align_int = _ALIGN_MAP[edit.align]
                rv = page.insert_textbox(
                    rect,
                    edit.newText,
                    fontname=fontname,
                    fontsize=edit.size,
                    color=color,
                    align=align_int,
                )
                try:
                    if rv is not None and float(rv) < 0:
                        warnings.append(
                            {
                                "fragId": edit.fragId,
                                "insertionId": None,
                                "pageIndex": page_index,
                                "code": "text_overflow",
                                "message": (
                                    f"Text didn't fit in fragment {edit.fragId}. "
                                    "Expand the box or shrink the font."
                                ),
                            }
                        )
                except (TypeError, ValueError):
                    pass
                # Resolve font_path: master takes precedence; else source.
                edit_font_path = _master_font_path(document_id, edit.fontRef)
                if edit_font_path is None:
                    edit_font_path = _source_font_path(document_id, edit.fontRef)
                _draw_text_decorations(
                    page,
                    x0,
                    y0,
                    x1,
                    y1,
                    edit.size,
                    color,
                    edit.underline,
                    edit.strikethrough,
                    text=edit.newText,
                    fontname=fontname,
                    font_path=edit_font_path,
                    align=edit.align,
                )

            text_insertions: list[TextInsertion] = []
            for ins in page_ins:
                if isinstance(ins, TextInsertion):
                    text_insertions.append(ins)
                elif isinstance(ins, ShapeInsertion):
                    _draw_shape(page, ins)
                elif isinstance(ins, LineInsertion):
                    _draw_line_or_arrow(page, ins)
                elif isinstance(ins, ImageInsertion):
                    _draw_image(page, ins, document_id)

            for ins in text_insertions:
                _insert_text(
                    page,
                    document_id,
                    ins,
                    registered,
                    page_bottom,
                    page_index,
                    warnings,
                )

        tmp_fd, tmp_path = tempfile.mkstemp(
            suffix=".pdf", dir=str(pdf_file.parent)
        )
        os.close(tmp_fd)
        try:
            doc.save(tmp_path, deflate=True, garbage=4, clean=True)
        except Exception:
            Path(tmp_path).unlink(missing_ok=True)
            raise
    finally:
        doc.close()

    assert tmp_path is not None
    return tmp_path, warnings
