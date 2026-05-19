"""Wrap bare CFF / Type1 font programs into OpenType (sfnt) containers.

Embedded PDF fonts often arrive as a stand-alone ``CFF`` blob (FontFile3 with
``/CFF``) or a Type1 ``PFB`` (FontFile/FontFile1).  Neither can be loaded by
a browser directly --- they're not valid sfnt containers.  This module wraps
such payloads with the minimum set of OpenType tables needed for fontTools
to round-trip them through WOFF2:

    CFF , head, hhea, hmtx, maxp, OS/2, name, post, cmap

The output ``.otf`` bytes can then be fed to ``fontTools.ttLib.TTFont`` with
``flavor='woff2'`` to produce a browser-loadable WOFF2.

Failure modes are bubbled to the caller as exceptions so the caller can fall
back to keeping the raw bytes on disk without a ``url``.
"""
from __future__ import annotations

import logging
from io import BytesIO
from typing import Any

from fontTools.agl import AGL2UV, toUnicode
from fontTools.cffLib import CFFFontSet, TopDict
from fontTools.pens.basePen import NullPen
from fontTools.ttLib import TTFont, newTable
from fontTools.ttLib.tables._c_m_a_p import CmapSubtable
from fontTools.ttLib.tables._n_a_m_e import NameRecord
from fontTools.ttLib.tables.O_S_2f_2 import Panose

logger = logging.getLogger(__name__)

DEFAULT_UPM = 1000
DEFAULT_ASCENT = 750
DEFAULT_DESCENT = -250
DEFAULT_WIDTH = 500
DEFAULT_FONT_BBOX = [-500, -250, 1500, 1100]


def cff_to_otf(cff_bytes: bytes, hint_psname: str = "WrappedCFF") -> bytes:
    """Wrap a bare CFF table into a complete OpenType (.otf) font.

    Returns the .otf binary on success. Raises on unrecoverable error.
    """
    if not cff_bytes:
        raise ValueError("empty CFF payload")

    cff = CFFFontSet()
    cff.decompile(BytesIO(cff_bytes), None, isCFF2=False)
    if len(cff.topDictIndex) == 0:
        raise ValueError("CFF has no TopDict")
    top: TopDict = cff.topDictIndex[0]

    ps_name = _pick_ps_name(top, cff, hint_psname)

    font = TTFont(sfntVersion="OTTO")

    # Embed the CFF table verbatim.
    cff_tbl = newTable("CFF ")
    cff_tbl.cff = cff
    font["CFF "] = cff_tbl

    # Glyph order: .notdef first, then everything else from the charset.
    glyph_order = _build_glyph_order(top)
    font.setGlyphOrder(glyph_order)

    # Drive advance widths out of CFF charstrings (requires draw() to populate
    # T2CharString.width based on Private.defaultWidthX/nominalWidthX).
    metrics, max_advance = _collect_widths(top, glyph_order)

    _add_head_table(font, top)
    _add_hhea_hmtx(font, metrics, max_advance, len(glyph_order))
    _add_maxp(font)
    _add_os2(font)
    _add_name(font, ps_name)
    _add_post(font, top)
    _add_cmap(font, glyph_order)

    buf = BytesIO()
    font.save(buf)
    return buf.getvalue()


def pfb_to_otf(pfb_bytes: bytes, hint_psname: str = "WrappedT1") -> bytes:
    """Wrap a Type1 PFB into OpenType.

    Type1 → CFF conversion involves re-emitting Type1 charstrings as Type2 in
    a new CFF, handling subrs, hinting and encodings correctly.  fontTools
    does not expose a one-call helper for this and a hand-rolled converter is
    out of scope for this turn.  We raise ``NotImplementedError`` so callers
    fall back to keeping the raw PFB on disk.
    """
    raise NotImplementedError(
        "Type1 (PFB/PFA) → OpenType wrapping is not implemented; "
        "falling back to raw font bytes."
    )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _pick_ps_name(top: TopDict, cff: CFFFontSet, hint: str) -> str:
    candidate = getattr(top, "FontName", None)
    if not candidate and cff.fontNames:
        candidate = cff.fontNames[0]
    if not candidate:
        candidate = hint or "WrappedFont"
    # PostScript names must be ASCII and contain no whitespace.
    safe = "".join(ch if (ch.isalnum() or ch in "-_.") else "_" for ch in str(candidate))
    return safe or "WrappedFont"


def _build_glyph_order(top: TopDict) -> list[str]:
    raw_charset = list(getattr(top, "charset", None) or [])
    # CharStrings always knows what's there; cross-reference to be safe.
    try:
        cs_names = list(top.CharStrings.keys())
    except Exception:
        cs_names = []
    seen: set[str] = set()
    ordered: list[str] = []
    if ".notdef" not in raw_charset:
        ordered.append(".notdef")
        seen.add(".notdef")
    for name in raw_charset + cs_names:
        if name not in seen:
            seen.add(name)
            ordered.append(name)
    if not ordered:
        ordered = [".notdef"]
    return ordered


def _collect_widths(
    top: TopDict, glyph_order: list[str]
) -> tuple[dict[str, tuple[int, int]], int]:
    metrics: dict[str, tuple[int, int]] = {}
    max_advance = 0
    private = getattr(top, "Private", None)
    default_width = int(getattr(private, "defaultWidthX", DEFAULT_WIDTH) or DEFAULT_WIDTH)
    for name in glyph_order:
        width: int | None = None
        try:
            cs = top.CharStrings[name]
            # draw() populates cs.width based on the program + Private widths.
            try:
                cs.draw(NullPen())
            except Exception as exc:
                logger.debug("draw failed for %s: %s", name, exc)
            w = getattr(cs, "width", None)
            if w is None:
                w = default_width
            width = int(w)
        except Exception as exc:
            logger.debug("width lookup failed for %s: %s", name, exc)
            width = default_width
        metrics[name] = (width, 0)
        if width > max_advance:
            max_advance = width
    if max_advance <= 0:
        max_advance = default_width
    return metrics, max_advance


def _add_head_table(font: TTFont, top: TopDict) -> None:
    head = newTable("head")
    head.tableVersion = 1.0
    head.fontRevision = 1.0
    head.checkSumAdjustment = 0
    head.magicNumber = 0x5F0F3CF5
    head.flags = 0x0003
    head.unitsPerEm = int(getattr(top, "UPM", DEFAULT_UPM) or DEFAULT_UPM)
    head.created = 0
    head.modified = 0
    bbox = list(getattr(top, "FontBBox", None) or DEFAULT_FONT_BBOX)
    if len(bbox) != 4:
        bbox = list(DEFAULT_FONT_BBOX)
    head.xMin, head.yMin, head.xMax, head.yMax = [int(v) for v in bbox]
    head.macStyle = 0
    head.lowestRecPPEM = 6
    head.fontDirectionHint = 2
    head.indexToLocFormat = 0
    head.glyphDataFormat = 0
    font["head"] = head


def _add_hhea_hmtx(
    font: TTFont,
    metrics: dict[str, tuple[int, int]],
    max_advance: int,
    num_glyphs: int,
) -> None:
    hmtx = newTable("hmtx")
    hmtx.metrics = metrics
    font["hmtx"] = hmtx

    hhea = newTable("hhea")
    hhea.tableVersion = 0x00010000
    hhea.ascent = DEFAULT_ASCENT
    hhea.descent = DEFAULT_DESCENT
    hhea.lineGap = 0
    hhea.advanceWidthMax = int(max_advance)
    hhea.minLeftSideBearing = 0
    hhea.minRightSideBearing = 0
    hhea.xMaxExtent = int(max_advance)
    hhea.caretSlopeRise = 1
    hhea.caretSlopeRun = 0
    hhea.caretOffset = 0
    hhea.reserved0 = 0
    hhea.reserved1 = 0
    hhea.reserved2 = 0
    hhea.reserved3 = 0
    hhea.metricDataFormat = 0
    hhea.numberOfHMetrics = int(num_glyphs)
    font["hhea"] = hhea


def _add_maxp(font: TTFont) -> None:
    maxp = newTable("maxp")
    # 0.5 is the CFF-flavoured maxp; it only carries numGlyphs.
    maxp.tableVersion = 0x00005000
    maxp.numGlyphs = len(font.getGlyphOrder())
    font["maxp"] = maxp


def _add_os2(font: TTFont) -> None:
    os2 = newTable("OS/2")
    os2.version = 4
    os2.xAvgCharWidth = DEFAULT_WIDTH
    os2.usWeightClass = 400
    os2.usWidthClass = 5
    os2.fsType = 0  # installable
    os2.ySubscriptXSize = 650
    os2.ySubscriptYSize = 600
    os2.ySubscriptXOffset = 0
    os2.ySubscriptYOffset = 75
    os2.ySuperscriptXSize = 650
    os2.ySuperscriptYSize = 600
    os2.ySuperscriptXOffset = 0
    os2.ySuperscriptYOffset = 350
    os2.yStrikeoutSize = 50
    os2.yStrikeoutPosition = 250
    os2.sFamilyClass = 0
    os2.panose = Panose()
    os2.ulUnicodeRange1 = 0xFFFFFFFF
    os2.ulUnicodeRange2 = 0xFFFFFFFF
    os2.ulUnicodeRange3 = 0xFFFFFFFF
    os2.ulUnicodeRange4 = 0xFFFFFFFF
    os2.achVendID = "    "
    os2.fsSelection = 0x40  # Regular
    os2.usFirstCharIndex = 0x20
    os2.usLastCharIndex = 0xFFFF
    os2.sTypoAscender = DEFAULT_ASCENT
    os2.sTypoDescender = DEFAULT_DESCENT
    os2.sTypoLineGap = 0
    os2.usWinAscent = DEFAULT_ASCENT
    os2.usWinDescent = abs(DEFAULT_DESCENT)
    os2.ulCodePageRange1 = 0xFFFFFFFF
    os2.ulCodePageRange2 = 0xFFFFFFFF
    os2.sxHeight = 500
    os2.sCapHeight = 700
    os2.usDefaultChar = 0
    os2.usBreakChar = 0x20
    os2.usMaxContext = 1
    font["OS/2"] = os2


def _add_name(font: TTFont, ps_name: str) -> None:
    name = newTable("name")
    name.names = []

    def add(name_id: int, value: str) -> None:
        rec = NameRecord()
        rec.nameID = name_id
        rec.platformID = 3
        rec.platEncID = 1
        rec.langID = 0x409
        rec.string = value.encode("utf-16-be")
        name.names.append(rec)

    add(1, ps_name)  # Family
    add(2, "Regular")  # Subfamily
    add(4, ps_name)  # Full name
    add(6, ps_name)  # PostScript name
    font["name"] = name


def _add_post(font: TTFont, top: TopDict) -> None:
    post = newTable("post")
    # Format 3.0 stores no glyph names -- fine for CFF fonts.
    post.formatType = 3.0
    post.italicAngle = float(getattr(top, "ItalicAngle", 0) or 0)
    post.underlinePosition = -100
    post.underlineThickness = 50
    post.isFixedPitch = 0
    post.minMemType42 = 0
    post.maxMemType42 = 0
    post.minMemType1 = 0
    post.maxMemType1 = 0
    font["post"] = post


def _glyph_name_to_unicode(name: str) -> int | None:
    if name in (".notdef", ".null", "nonmarkingreturn"):
        return None
    cp = AGL2UV.get(name)
    if cp is not None:
        return cp
    # uniXXXX (4 hex digits, BMP)
    if name.startswith("uni") and len(name) == 7:
        try:
            return int(name[3:], 16)
        except ValueError:
            pass
    # u + 4..6 hex digits (any plane)
    if name.startswith("u") and 5 <= len(name) <= 7:
        try:
            return int(name[1:], 16)
        except ValueError:
            pass
    # AGL helper handles ligature-style names (returns a string) too.
    try:
        decoded = toUnicode(name)
    except Exception:
        decoded = None
    if isinstance(decoded, str) and len(decoded) == 1:
        return ord(decoded)
    return None


def _add_cmap(font: TTFont, glyph_order: list[str]) -> None:
    cmap_table = newTable("cmap")
    cmap_table.tableVersion = 0

    glyph_to_uni: dict[int, str] = {}
    for name in glyph_order:
        cp = _glyph_name_to_unicode(name)
        if cp is None:
            continue
        if 0 <= cp <= 0xFFFF and cp not in glyph_to_uni:
            glyph_to_uni[cp] = name

    sub_cls = CmapSubtable.getSubtableClass(4)
    sub = sub_cls("cmap")
    sub.format = 4
    sub.length = 0  # recomputed on compile
    sub.platformID = 3
    sub.platEncID = 1
    sub.language = 0
    sub.cmap = glyph_to_uni
    cmap_table.tables = [sub]
    font["cmap"] = cmap_table
