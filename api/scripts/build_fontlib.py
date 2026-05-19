"""Build the local font library from macOS Supplemental + vendored fonts.

Re-running is idempotent: existing valid index entries are kept and only
missing files are produced. Missing macOS supplemental paths are skipped
silently so the script remains useful on Linux/Windows for the vendor
fonts at least.
"""

from __future__ import annotations

import json
import re
import shutil
import sys
from io import BytesIO
from pathlib import Path

from fontTools.ttLib import TTFont

API_ROOT = Path(__file__).resolve().parent.parent
FONTLIB_DIR = API_ROOT / "fontlib"
INDEX_PATH = FONTLIB_DIR / "index.json"
VENDOR_URW_DIR = FONTLIB_DIR / "vendor" / "urw"
VENDOR_LIBERATION_DIR = FONTLIB_DIR / "vendor" / "liberation"

SYSTEM_FONT_DIR = Path("/System/Library/Fonts/Supplemental")

# Files resolved relative to SYSTEM_FONT_DIR (macOS supplemental fonts).
SOURCE_FONT_FILES = [
    "Arial.ttf",
    "Arial Bold.ttf",
    "Arial Italic.ttf",
    "Arial Bold Italic.ttf",
    "Times New Roman.ttf",
    "Times New Roman Bold.ttf",
    "Times New Roman Italic.ttf",
    "Times New Roman Bold Italic.ttf",
    "Courier New.ttf",
    "Courier New Bold.ttf",
    "Courier New Italic.ttf",
    "Courier New Bold Italic.ttf",
    "Georgia.ttf",
    "Georgia Bold.ttf",
    "Georgia Italic.ttf",
    "Georgia Bold Italic.ttf",
    "Verdana.ttf",
    "Verdana Bold.ttf",
    "Verdana Italic.ttf",
    "Verdana Bold Italic.ttf",
    "Tahoma.ttf",
    "Tahoma Bold.ttf",
    "Trebuchet MS.ttf",
    "Trebuchet MS Bold.ttf",
    "Trebuchet MS Italic.ttf",
    "Trebuchet MS Bold Italic.ttf",
    "Comic Sans MS.ttf",
    "Comic Sans MS Bold.ttf",
    "Impact.ttf",
]

# Vendor fonts: explicit absolute paths so they work on every platform.
# (filename, override_family_hint or None, sourceTier)
#
# Source-tier ordering — earlier ingestions win and later duplicates are
# skipped by psName. We list macOS supplemental files first (highest
# fidelity for Arial/Times/Courier/etc.), then Liberation as a Linux/
# Windows-friendly metric-compatible fallback, then URW Nimbus to cover
# the rest of the PostScript-named Base 35 lookups (Helvetica, Times-Roman,
# Courier).
VENDOR_FONT_FILES: list[tuple[Path, str | None, str]] = [
    # URW symbol/dingbat fonts (already used in Wave 1).
    (VENDOR_URW_DIR / "StandardSymbolsPS-Regular.otf", "Symbol", "urw"),
    (VENDOR_URW_DIR / "D050000L.otf", "Dingbats", "urw"),
    # Liberation Fonts — metric-compatible substitutes for Arial / Times New
    # Roman / Courier New. Keep familyName from the font's own name table so
    # PSName lookups (LiberationSans-Regular etc.) succeed even when family
    # keyword routing falls back.
    (VENDOR_LIBERATION_DIR / "LiberationSans-Regular.ttf", None, "liberation"),
    (VENDOR_LIBERATION_DIR / "LiberationSans-Bold.ttf", None, "liberation"),
    (VENDOR_LIBERATION_DIR / "LiberationSans-Italic.ttf", None, "liberation"),
    (VENDOR_LIBERATION_DIR / "LiberationSans-BoldItalic.ttf", None, "liberation"),
    (VENDOR_LIBERATION_DIR / "LiberationSerif-Regular.ttf", None, "liberation"),
    (VENDOR_LIBERATION_DIR / "LiberationSerif-Bold.ttf", None, "liberation"),
    (VENDOR_LIBERATION_DIR / "LiberationSerif-Italic.ttf", None, "liberation"),
    (VENDOR_LIBERATION_DIR / "LiberationSerif-BoldItalic.ttf", None, "liberation"),
    (VENDOR_LIBERATION_DIR / "LiberationMono-Regular.ttf", None, "liberation"),
    (VENDOR_LIBERATION_DIR / "LiberationMono-Bold.ttf", None, "liberation"),
    (VENDOR_LIBERATION_DIR / "LiberationMono-Italic.ttf", None, "liberation"),
    (VENDOR_LIBERATION_DIR / "LiberationMono-BoldItalic.ttf", None, "liberation"),
    # URW Nimbus — the PostScript-named Base 35 set. Helvetica, Times-Roman
    # and Courier (the Adobe core 12) live here, with the familyName left as
    # the font's own value so PSName matching wins on embedded PDFs that
    # reference Helvetica/Times-Roman/Courier directly.
    (VENDOR_URW_DIR / "NimbusSans-Regular.otf", None, "urw"),
    (VENDOR_URW_DIR / "NimbusSans-Bold.otf", None, "urw"),
    (VENDOR_URW_DIR / "NimbusSans-Italic.otf", None, "urw"),
    (VENDOR_URW_DIR / "NimbusSans-BoldItalic.otf", None, "urw"),
    (VENDOR_URW_DIR / "NimbusRoman-Regular.otf", None, "urw"),
    (VENDOR_URW_DIR / "NimbusRoman-Bold.otf", None, "urw"),
    (VENDOR_URW_DIR / "NimbusRoman-Italic.otf", None, "urw"),
    (VENDOR_URW_DIR / "NimbusRoman-BoldItalic.otf", None, "urw"),
    (VENDOR_URW_DIR / "NimbusMonoPS-Regular.otf", None, "urw"),
    (VENDOR_URW_DIR / "NimbusMonoPS-Bold.otf", None, "urw"),
    (VENDOR_URW_DIR / "NimbusMonoPS-Italic.otf", None, "urw"),
    (VENDOR_URW_DIR / "NimbusMonoPS-BoldItalic.otf", None, "urw"),
]


def _get_name(font: TTFont, name_id: int) -> str | None:
    name_table = font["name"]
    record = name_table.getName(name_id, 3, 1, 0x409)
    if record is None:
        record = name_table.getName(name_id, 1, 0, 0)
    if record is None:
        record = name_table.getName(name_id, 0, 3, 0)
    if record is None:
        for r in name_table.names:
            if r.nameID == name_id:
                record = r
                break
    if record is None:
        return None
    try:
        return record.toUnicode()
    except Exception:
        return None


def _slugify(ps_name: str) -> str:
    s = ps_name.lower()
    s = re.sub(r"[^a-z0-9]+", "-", s).strip("-")
    return s or "font"


def _entry_is_valid(entry: dict, fontlib_dir: Path) -> bool:
    required = ("ttfPath", "woff2Path", "psName", "slug")
    if not all(entry.get(k) for k in required):
        return False
    ttf = API_ROOT / entry["ttfPath"]
    woff2 = API_ROOT / entry["woff2Path"]
    return ttf.exists() and woff2.exists()


def _read_existing_index() -> dict[str, dict]:
    if not INDEX_PATH.exists():
        return {}
    try:
        existing = json.loads(INDEX_PATH.read_text())
    except Exception:
        return {}
    out: dict[str, dict] = {}
    if isinstance(existing, list):
        for entry in existing:
            if isinstance(entry, dict) and entry.get("psName"):
                out[entry["psName"]] = entry
    return out


def _process_font(
    source: Path,
    existing_by_ps: dict[str, dict],
    family_override: str | None = None,
    source_tier: str = "system",
) -> dict | None:
    try:
        font = TTFont(str(source))
    except Exception as exc:
        print(f"  skip (open failed): {source.name}: {exc}", file=sys.stderr)
        return None

    ps_name = _get_name(font, 6)
    family = _get_name(font, 1)
    subfamily = _get_name(font, 2)
    if not ps_name:
        ps_name = source.stem.replace(" ", "")
    if family_override:
        family = family_override
    if not family:
        family = source.stem
    if not subfamily:
        subfamily = "Regular"

    slug = _slugify(ps_name)

    os2 = font["OS/2"]
    panose = [
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
    weight_class = int(getattr(os2, "usWeightClass", 400) or 400)
    italic = bool(getattr(os2, "fsSelection", 0) & 0x01)
    bold = bool(getattr(os2, "fsSelection", 0) & 0x20) or weight_class >= 600
    cap_height = int(getattr(os2, "sCapHeight", 0) or 0) if hasattr(os2, "sCapHeight") else None
    x_height = int(getattr(os2, "sxHeight", 0) or 0) if hasattr(os2, "sxHeight") else None

    hhea = font["hhea"]
    ascender = int(hhea.ascent)
    descender = int(hhea.descent)

    post = font["post"]
    italic_angle = float(getattr(post, "italicAngle", 0.0) or 0.0)

    head = font["head"]
    units_per_em = int(head.unitsPerEm)

    codepoints = sorted(int(cp) for cp in font.getBestCmap().keys())

    ttf_target = FONTLIB_DIR / f"{slug}.ttf"
    woff2_target = FONTLIB_DIR / f"{slug}.woff2"

    if not ttf_target.exists():
        shutil.copyfile(source, ttf_target)

    if not woff2_target.exists():
        woff2_font = TTFont(str(source))
        woff2_font.flavor = "woff2"
        buf = BytesIO()
        woff2_font.save(buf)
        woff2_target.write_bytes(buf.getvalue())

    entry = {
        "psName": ps_name,
        "familyName": family,
        "subfamily": subfamily,
        "slug": slug,
        "ttfPath": f"fontlib/{slug}.ttf",
        "woff2Path": f"fontlib/{slug}.woff2",
        "bold": bold,
        "italic": italic,
        "usWeightClass": weight_class,
        "panose": panose,
        "capHeight": cap_height,
        "xHeight": x_height,
        "ascender": ascender,
        "descender": descender,
        "italicAngle": italic_angle,
        "unitsPerEm": units_per_em,
        "availableCodepoints": codepoints,
        "sourceTier": source_tier,
    }
    return entry


def _ingest_source(
    source: Path,
    existing_by_ps: dict[str, dict],
    entries: list[dict],
    seen_ps: set[str],
    family_override: str | None,
    counters: dict[str, int],
    source_tier: str = "system",
) -> None:
    if not source.exists():
        print(f"  skip (missing): {source.name}", file=sys.stderr)
        counters["skipped"] += 1
        return

    ps_probe: str | None = None
    try:
        f = TTFont(str(source))
        ps_probe = _get_name(f, 6) or source.stem.replace(" ", "")
    except Exception:
        ps_probe = None

    if ps_probe and ps_probe in existing_by_ps and _entry_is_valid(
        existing_by_ps[ps_probe], FONTLIB_DIR
    ):
        if ps_probe in seen_ps:
            return
        existing_entry = existing_by_ps[ps_probe]
        # Refresh familyName from override if requested.
        if family_override and existing_entry.get("familyName") != family_override:
            existing_entry["familyName"] = family_override
        # Ensure sourceTier is populated/refreshed on reused entries.
        existing_entry["sourceTier"] = source_tier
        entries.append(existing_entry)
        seen_ps.add(ps_probe)
        counters["reused"] += 1
        return

    entry = _process_font(
        source,
        existing_by_ps,
        family_override=family_override,
        source_tier=source_tier,
    )
    if entry is None:
        counters["skipped"] += 1
        return
    if entry["psName"] in seen_ps:
        return
    entries.append(entry)
    seen_ps.add(entry["psName"])
    counters["built"] += 1


def main() -> int:
    FONTLIB_DIR.mkdir(parents=True, exist_ok=True)

    existing_by_ps = _read_existing_index()
    entries: list[dict] = []
    seen_ps: set[str] = set()
    counters = {"built": 0, "reused": 0, "skipped": 0}

    # System (macOS supplemental) fonts: gracefully skipped on Linux/Windows.
    for filename in SOURCE_FONT_FILES:
        _ingest_source(
            SYSTEM_FONT_DIR / filename,
            existing_by_ps,
            entries,
            seen_ps,
            family_override=None,
            counters=counters,
            source_tier="system",
        )

    # Vendor (Liberation + URW Nimbus) fonts: present on every platform via the
    # repository. Earlier list entries win on psName collisions, so URW symbol
    # fonts and Liberation Sans/Serif/Mono ingest before Nimbus PSName aliases.
    for source, family_override, source_tier in VENDOR_FONT_FILES:
        _ingest_source(
            source,
            existing_by_ps,
            entries,
            seen_ps,
            family_override=family_override,
            counters=counters,
            source_tier=source_tier,
        )

    INDEX_PATH.write_text(json.dumps(entries, indent=2, ensure_ascii=False))

    total_bytes = 0
    for entry in entries:
        for key in ("ttfPath", "woff2Path"):
            p = API_ROOT / entry[key]
            if p.exists():
                total_bytes += p.stat().st_size

    size_mb = total_bytes / (1024 * 1024)
    total = len(entries)
    print(
        f"Built {total} fonts in fontlib/, total size {size_mb:.1f} MB "
        f"(new: {counters['built']}, reused: {counters['reused']}, "
        f"skipped: {counters['skipped']})"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
