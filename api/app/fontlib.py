from __future__ import annotations

import json
import logging
import math
import re
import threading
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

API_ROOT = Path(__file__).resolve().parent.parent
FONTLIB_DIR = API_ROOT / "fontlib"
INDEX_PATH = FONTLIB_DIR / "index.json"

_SUBSET_RE = re.compile(r"^([A-Z]{6})\+(.+)$")

# Order matters: more specific tokens first so e.g. "Trebuchet" wins before
# generic "Times"/"Arial" checks could ever apply. Symbol/Dingbats are
# prepended so they take precedence over the broader Latin keyword catches.
# Liberation/Nimbus aliases are appended at the end so existing tokens win
# on PANOSE distance ties (the original PostScript names still take priority
# via direct psName matching before keyword routing is consulted).
_FAMILY_KEYWORDS: list[tuple[tuple[str, ...], str]] = [
    (("zapfdingbats", "dingbats", "itcdingbats"), "Dingbats"),
    (("standardsymbol", "symbolps", "symbol"), "Symbol"),
    (("trebuchet",), "Trebuchet MS"),
    (("comic",), "Comic Sans MS"),
    (("impact",), "Impact"),
    (("verdana",), "Verdana"),
    (("tahoma",), "Tahoma"),
    (("georgia",), "Georgia"),
    (("couriernew", "courier"), "Courier New"),
    (("timesnewroman", "timesroman", "times"), "Times New Roman"),
    (("helvetica", "arial"), "Arial"),
    (("liberationsans",), "Arial"),
    (("liberationserif",), "Times New Roman"),
    (("liberationmono",), "Courier New"),
    (("nimbussans", "helveticaneue"), "Arial"),
    (("nimbusroman",), "Times New Roman"),
    (("nimbusmonops", "nimbusmono"), "Courier New"),
]

_lock = threading.Lock()
_cache: list[dict[str, Any]] | None = None


def load_fontlib() -> list[dict[str, Any]]:
    global _cache
    with _lock:
        if _cache is not None:
            return _cache
        if not INDEX_PATH.exists():
            logger.warning("fontlib index missing at %s; matcher will return None", INDEX_PATH)
            _cache = []
            return _cache
        try:
            data = json.loads(INDEX_PATH.read_text())
        except Exception as exc:
            logger.error("failed to load fontlib index: %s", exc)
            _cache = []
            return _cache
        if not isinstance(data, list):
            _cache = []
            return _cache
        _cache = data
        return _cache


def _strip_subset(ps_name: str) -> str:
    if not ps_name:
        return ""
    match = _SUBSET_RE.match(ps_name)
    if match:
        return match.group(2)
    return ps_name


def _normalise_token(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", (s or "").lower())


def _master_url(entry: dict[str, Any]) -> str:
    return f"/api/fontlib/{entry['slug']}.woff2"


def _matches_style(entry: dict[str, Any], bold: bool, italic: bool) -> bool:
    return bool(entry.get("bold")) == bold and bool(entry.get("italic")) == italic


def _pick_in_family(family: str, bold: bool, italic: bool, lib: list[dict[str, Any]]) -> dict[str, Any] | None:
    candidates = [e for e in lib if e.get("familyName") == family]
    if not candidates:
        return None
    for entry in candidates:
        if _matches_style(entry, bold, italic):
            return entry
    if italic:
        for entry in candidates:
            if _matches_style(entry, bold, False):
                return entry
    if bold:
        for entry in candidates:
            if _matches_style(entry, False, italic):
                return entry
    for entry in candidates:
        if _matches_style(entry, False, False):
            return entry
    return candidates[0]


def _panose_distance(a: list[int], b: list[int]) -> float:
    if not a or not b or len(a) < 10 or len(b) < 10:
        return float("inf")
    if all(v == 0 for v in a) or all(v == 0 for v in b):
        return float("inf")
    total = 0.0
    for i in range(10):
        diff = a[i] - b[i]
        total += diff * diff
    return math.sqrt(total)


def _serif_group(b_serif_style: int) -> str | None:
    """Classify PANOSE bSerifStyle into a serif/sans group.

    PANOSE-1 Latin Text classification of bSerifStyle:
      0  Any        -> wildcard (None)
      1  No Fit     -> wildcard (None)
      2..10         -> serif family (Cove, Obtuse Cove, Square Cove,
                       Square, Thin, Bone, Exaggerated, Triangle, Normal Sans /
                       in PANOSE the 2..10 range is serif subtypes)
      11..15        -> sans-serif family (Normal Sans, Obtuse Sans,
                       Perp Sans, Flared, Rounded)
    """
    if b_serif_style in (0, 1):
        return None
    if 2 <= b_serif_style <= 10:
        return "serif"
    if 11 <= b_serif_style <= 15:
        return "sans"
    return None


def _panose_compatible(a: list[int], b: list[int]) -> bool:
    """Check whether two PANOSE arrays are in compatible classifications.

    Compares bFamilyType (byte 0) and bSerifStyle (byte 1). Values 0 (Any)
    and 1 (No Fit) act as wildcards for the given field. A real Latin Sans
    (bSerifStyle 11..15) must never match a Latin Serif (bSerifStyle 2..10).
    """
    if not a or not b or len(a) < 2 or len(b) < 2:
        return False
    a_family, b_family = a[0], b[0]
    a_serif, b_serif = a[1], b[1]

    # bFamilyType: 0/1 are wildcards; otherwise require exact match.
    if a_family not in (0, 1) and b_family not in (0, 1):
        if a_family != b_family:
            return False

    # bSerifStyle: 0/1 are wildcards; otherwise require same serif group.
    a_group = _serif_group(a_serif)
    b_group = _serif_group(b_serif)
    if a_group is not None and b_group is not None and a_group != b_group:
        return False

    return True


def find_master(
    ps_name: str,
    base_name: str,
    bold: bool,
    italic: bool,
    panose: list[int] | None,
    italic_angle: float | None,
    cap_height: float | None,
    x_height: float | None,
    units_per_em: int | None,
) -> tuple[dict[str, Any], str] | None:
    lib = load_fontlib()
    if not lib:
        return None

    stripped = _strip_subset(ps_name or "")
    norm_ps = _normalise_token(stripped)
    norm_base = _normalise_token(base_name or "")

    if norm_ps:
        for entry in lib:
            if _normalise_token(entry.get("psName", "")) == norm_ps:
                return entry, "psName"
    if norm_base and norm_base != norm_ps:
        for entry in lib:
            if _normalise_token(entry.get("psName", "")) == norm_base:
                return entry, "psName"

    haystack = norm_ps + "|" + norm_base
    for tokens, family in _FAMILY_KEYWORDS:
        if any(tok in haystack for tok in tokens):
            picked = _pick_in_family(family, bold, italic, lib)
            if picked is not None:
                return picked, "familyKeyword"

    if panose and len(panose) >= 10 and not all(v == 0 for v in panose):
        best: tuple[dict[str, Any], float] | None = None
        for entry in lib:
            if not _matches_style(entry, bold, italic):
                continue
            entry_panose = entry.get("panose") or []
            if not _panose_compatible(panose, entry_panose):
                continue
            dist = _panose_distance(panose, entry_panose)
            if dist == float("inf"):
                continue
            if best is None or dist < best[1]:
                best = (entry, dist)
        if best is not None:
            return best[0], "panose"

    lower = (base_name or "").lower() + " " + (ps_name or "").lower()
    if "mono" in lower or "courier" in lower:
        picked = _pick_in_family("Courier New", False, False, lib)
    elif "sans" in lower:
        picked = _pick_in_family("Arial", False, False, lib)
    elif "serif" in lower or "times" in lower:
        picked = _pick_in_family("Times New Roman", False, False, lib)
    else:
        picked = _pick_in_family("Arial", False, False, lib)
    if picked is not None:
        return picked, "fallback"

    return None


def master_url_for(entry: dict[str, Any]) -> str:
    return _master_url(entry)


def master_woff2_path(entry: dict[str, Any]) -> Path:
    return API_ROOT / entry["woff2Path"]


def master_ttf_path(entry: dict[str, Any]) -> Path:
    return API_ROOT / entry["ttfPath"]
