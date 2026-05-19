from __future__ import annotations

import logging
import os
import re
import shutil
from concurrent.futures import ThreadPoolExecutor
from io import BytesIO
from typing import Any

from fontTools.ttLib import TTFont

from app import storage
from app.fontlib import find_master, master_ttf_path, master_woff2_path

logger = logging.getLogger(__name__)

_SUBSET_RE = re.compile(r"^([A-Z]{6})\+(.+)$")
_CONVERTIBLE_EXTS = {"ttf", "otf"}
_RAW_KEEP_EXTS = {"cff", "pfb"}

_LATIN1_BASELINE: list[int] = list(range(0x20, 0x7F)) + list(range(0xA0, 0x100))


def parse_ps_name(name: str) -> tuple[str | None, str]:
    if not name:
        return None, ""
    match = _SUBSET_RE.match(name)
    if match:
        return match.group(1), match.group(2)
    return None, name


def infer_bold_italic_from_name(name: str) -> tuple[bool, bool]:
    lower = (name or "").lower()
    bold = "bold" in lower
    italic = ("italic" in lower) or ("oblique" in lower)
    return bold, italic


def fallback_family_for(name: str) -> str:
    lower = (name or "").lower()
    # Strip non-alphanumerics so e.g. "Open Sans", "open-sans", "OpenSans"
    # all match the "opensans" keyword below.
    compact = re.sub(r"[^a-z0-9]+", "", lower)
    inter_like_keywords = (
        "inter",
        "roboto",
        "opensans",
        "notosans",
        "sourcesans",
        "publicsans",
        "ibmplexsans",
        "montserrat",
        "lato",
    )
    if any(tok in compact for tok in inter_like_keywords):
        return (
            "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', "
            "Roboto, Helvetica, Arial, sans-serif"
        )
    if "helvetica" in lower or "arial" in lower:
        return "Helvetica, Arial, sans-serif"
    if "times" in lower:
        return "'Times New Roman', Times, serif"
    if "courier" in lower:
        return "'Courier New', Courier, monospace"
    if "symbol" in lower:
        return "Symbol, serif"
    if "sans" in lower:
        return (
            "-apple-system, BlinkMacSystemFont, 'Segoe UI', "
            "Roboto, Helvetica, Arial, sans-serif"
        )
    return "sans-serif"


def _to_woff2(font_bytes: bytes) -> bytes:
    font = TTFont(BytesIO(font_bytes))
    font.flavor = "woff2"
    buf = BytesIO()
    font.save(buf)
    return buf.getvalue()


def _read_internal_psname(font_bytes: bytes) -> str | None:
    try:
        font = TTFont(BytesIO(font_bytes))
        name_table = font["name"]
        record = name_table.getName(6, 3, 1) or name_table.getName(6, 1, 0) or name_table.getName(6, 0, 0)
        if record is None:
            return None
        return record.toUnicode()
    except Exception:
        return None


def _fs_type_label(value: int | None) -> str | None:
    """Decode the OS/2 fsType permission bits per the OpenType spec.

    See https://learn.microsoft.com/typography/opentype/spec/os2#fstype.
    The low 4 bits encode mutually-exclusive embedding permissions:
      0x0000 -> installable
      0x0002 -> restricted (no embedding)
      0x0004 -> preview & print
      0x0008 -> editable
    All other higher bits (subsetting bit 8, bitmap-only bit 9) are
    informational and ignored here.
    """
    if value is None:
        return None
    perm = value & 0x000F
    if perm == 0x0000:
        return "installable"
    if perm & 0x0002:
        return "restricted"
    if perm & 0x0004:
        return "preview"
    if perm & 0x0008:
        return "editable"
    return "installable"


def _read_font_metadata(font_bytes: bytes) -> dict[str, Any]:
    out: dict[str, Any] = {
        "panose": None,
        "italicAngle": None,
        "capHeight": None,
        "xHeight": None,
        "unitsPerEm": None,
        "codepoints": [],
        "fsType": None,
    }
    try:
        font = TTFont(BytesIO(font_bytes))
    except Exception as exc:
        logger.debug("metadata TTFont open failed: %s", exc)
        return out
    try:
        os2 = font["OS/2"]
        out["panose"] = [
            int(os2.panose.bFamilyType),
            int(os2.panose.bSerifStyle),
            int(os2.panose.bWeight),
            int(os2.panose.bProportion),
            int(os2.panose.bContrast),
            int(os2.panose.bStrokeVariation),
            int(os2.panose.bArmStyle),
            int(os2.panose.bLetterForm),
            int(os2.panose.bMidline),
            int(os2.panose.bXHeight),
        ]
        if hasattr(os2, "sCapHeight"):
            out["capHeight"] = int(os2.sCapHeight or 0)
        if hasattr(os2, "sxHeight"):
            out["xHeight"] = int(os2.sxHeight or 0)
        try:
            fs_type_raw = getattr(os2, "fsType", None)
            if fs_type_raw is not None:
                out["fsType"] = int(fs_type_raw)
        except Exception as exc:
            logger.debug("fsType read failed: %s", exc)
    except Exception as exc:
        logger.debug("OS/2 read failed: %s", exc)
    try:
        post = font["post"]
        out["italicAngle"] = float(getattr(post, "italicAngle", 0.0) or 0.0)
    except Exception:
        pass
    try:
        out["unitsPerEm"] = int(font["head"].unitsPerEm)
    except Exception:
        pass
    try:
        out["codepoints"] = sorted(int(cp) for cp in font.getBestCmap().keys())
    except Exception as exc:
        logger.debug("cmap read failed: %s", exc)
    return out


def _build_font_entry(
    doc: Any,
    xref: int,
    basefont_hint: str,
    ext_hint: str,
    document_id: str,
) -> tuple[dict[str, Any], str | None]:
    ref = f"f{xref}"
    ps_name = basefont_hint or ""
    ext = (ext_hint or "").lower()
    content: bytes = b""

    try:
        result = doc.extract_font(xref)
    except Exception as exc:
        logger.warning("extract_font(%s) failed: %s", xref, exc)
        result = None

    if isinstance(result, tuple) and len(result) >= 4:
        extracted_basefont = result[0] or ""
        extracted_ext = (result[1] or "").lower()
        content_bytes = result[3] if isinstance(result[3], (bytes, bytearray)) else b""
        if extracted_basefont:
            ps_name = extracted_basefont
        if extracted_ext:
            ext = extracted_ext
        content = bytes(content_bytes) if content_bytes else b""

    subset_tag, base_name = parse_ps_name(ps_name)
    bold, italic = infer_bold_italic_from_name(base_name)
    fallback = fallback_family_for(base_name)

    fmt: str | None = None
    url: str | None = None
    internal_ps: str | None = None
    meta: dict[str, Any] = {
        "panose": None,
        "italicAngle": None,
        "capHeight": None,
        "xHeight": None,
        "unitsPerEm": None,
        "codepoints": [],
    }

    if content and ext in _CONVERTIBLE_EXTS:
        internal_ps = _read_internal_psname(content)
        meta = _read_font_metadata(content)
        fonts_root = storage.fonts_dir(document_id)
        fonts_root.mkdir(parents=True, exist_ok=True)
        source_target = fonts_root / f"{ref}.{ext}"
        try:
            source_target.write_bytes(content)
        except Exception as exc:
            logger.warning("Source font write failed for xref %s (%s): %s", xref, ps_name, exc)
        try:
            woff2 = _to_woff2(content)
            target = fonts_root / f"{ref}.woff2"
            target.write_bytes(woff2)
            fmt = "woff2"
            url = f"/api/doc/{document_id}/fonts/{ref}.woff2"
        except Exception as exc:
            logger.warning("WOFF2 conversion failed for xref %s (%s): %s", xref, ps_name, exc)
            fmt = ext
            url = f"/api/doc/{document_id}/fonts/{ref}.{ext}"
    elif content and ext in _RAW_KEEP_EXTS:
        fonts_root = storage.fonts_dir(document_id)
        fonts_root.mkdir(parents=True, exist_ok=True)
        # Always keep the original on disk for debugging / future re-wrap.
        source_target = fonts_root / f"{ref}.{ext}"
        try:
            source_target.write_bytes(content)
        except Exception as exc:
            logger.warning(
                "Source font write failed for xref %s (%s/%s): %s",
                xref, ps_name, ext, exc,
            )
        wrap_ok = False
        try:
            from app.font_wrap import cff_to_otf, pfb_to_otf
            if ext == "cff":
                otf_bytes = cff_to_otf(content, hint_psname=base_name or "WrappedCFF")
            else:  # pfb / pfa
                otf_bytes = pfb_to_otf(content, hint_psname=base_name or "WrappedT1")
            woff2_bytes = _to_woff2(otf_bytes)
            target = fonts_root / f"{ref}.woff2"
            target.write_bytes(woff2_bytes)
            fmt = "woff2"
            url = f"/api/doc/{document_id}/fonts/{ref}.woff2"
            # Populate metadata from the wrapped sfnt so we get a real cmap,
            # OS/2 panose, fsType etc. for downstream font matching.
            try:
                meta = _read_font_metadata(otf_bytes)
                internal_ps = _read_internal_psname(otf_bytes) or internal_ps
            except Exception as exc:
                logger.warning(
                    "metadata read from wrapped %s font failed for xref %s: %s",
                    ext, xref, exc,
                )
            wrap_ok = True
        except NotImplementedError as exc:
            logger.warning(
                "Wrapping not implemented for xref %s (%s/%s): %s",
                xref, ps_name, ext, exc,
            )
        except Exception as exc:
            logger.warning(
                "CFF/Type1 wrap failed for xref %s (%s/%s): %s",
                xref, ps_name, ext, exc,
            )
        if not wrap_ok:
            # Fall back to the previous behaviour: keep raw bytes, no url.
            fmt = None
            url = None

    available_codepoints: list[int] = meta.get("codepoints") or []
    if not available_codepoints:
        available_codepoints = list(_LATIN1_BASELINE)

    master_url: str | None = None
    master_ps_name: str | None = None
    master_family: str | None = None
    matched_by: str | None = None

    match_ps = internal_ps or ps_name
    try:
        match = find_master(
            ps_name=match_ps,
            base_name=base_name,
            bold=bold,
            italic=italic,
            panose=meta.get("panose"),
            italic_angle=meta.get("italicAngle"),
            cap_height=meta.get("capHeight"),
            x_height=meta.get("xHeight"),
            units_per_em=meta.get("unitsPerEm"),
        )
    except Exception as exc:
        logger.warning("find_master failed for %s: %s", ps_name, exc)
        match = None

    if match is not None:
        master_entry, matched_by = match
        try:
            fonts_root = storage.fonts_dir(document_id)
            fonts_root.mkdir(parents=True, exist_ok=True)
            src_woff2 = master_woff2_path(master_entry)
            src_ttf = master_ttf_path(master_entry)
            dst_woff2 = fonts_root / f"{ref}-master.woff2"
            dst_ttf = fonts_root / f"{ref}-master.ttf"
            if src_woff2.exists():
                shutil.copyfile(src_woff2, dst_woff2)
                master_url = f"/api/doc/{document_id}/fonts/{ref}-master.woff2"
            if src_ttf.exists():
                shutil.copyfile(src_ttf, dst_ttf)
            master_ps_name = master_entry.get("psName")
            master_family = master_entry.get("familyName")
        except Exception as exc:
            logger.warning("master copy failed for %s: %s", ps_name, exc)

    fs_type_value = meta.get("fsType") if isinstance(meta, dict) else None
    entry = {
        "ref": ref,
        "psName": ps_name,
        "subsetTag": subset_tag,
        "baseName": base_name,
        "format": fmt,
        "url": url,
        "bold": bold,
        "italic": italic,
        "fallbackFamily": fallback,
        "masterUrl": master_url,
        "masterPsName": master_ps_name,
        "masterFamily": master_family,
        "availableCodepoints": available_codepoints,
        "matchedBy": matched_by,
        "fsType": fs_type_value,
        "fsTypeLabel": _fs_type_label(fs_type_value),
    }
    return entry, internal_ps


def extract_fonts(doc: Any, document_id: str) -> tuple[list[dict[str, Any]], dict[str, str]]:
    seen_xrefs: set[int] = set()
    font_entries: list[dict[str, Any]] = []
    psname_to_ref: dict[str, str] = {}

    pending: list[tuple[int, str, str]] = []
    for pno in range(doc.page_count):
        try:
            page_fonts = doc.get_page_fonts(pno, full=False)
        except Exception as exc:
            logger.warning("get_page_fonts(%s) failed: %s", pno, exc)
            continue
        for item in page_fonts:
            if not item or len(item) < 4:
                continue
            xref = item[0]
            ext_hint = item[1] if len(item) > 1 else ""
            basefont_hint = item[3] if len(item) > 3 else ""
            if xref in seen_xrefs:
                continue
            seen_xrefs.add(xref)
            pending.append((xref, basefont_hint or "", ext_hint or ""))

    parallel = os.environ.get("PDF_EDITOR_PARALLEL_FONTS") == "1"

    def _worker(item: tuple[int, str, str]) -> tuple[dict[str, Any], str | None]:
        xref, basefont, ext = item
        return _build_font_entry(doc, xref, basefont, ext, document_id)

    if parallel and pending:
        # ThreadPoolExecutor.map preserves input order so xref refs stay
        # deterministic. WOFF2 conversion is the dominant cost (CPU-bound but
        # releases the GIL inside brotli), making threads a sensible choice.
        with ThreadPoolExecutor(max_workers=4) as ex:
            results = list(ex.map(_worker, pending))
    else:
        results = [_worker(item) for item in pending]

    for entry, internal_ps in results:
        font_entries.append(entry)
        ref = entry["ref"]
        ps_name = entry["psName"]
        base_name = entry["baseName"]
        for key in (ps_name, base_name, internal_ps):
            if key and key not in psname_to_ref:
                psname_to_ref[key] = ref

    return font_entries, psname_to_ref
