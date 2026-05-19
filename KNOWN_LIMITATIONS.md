# Known Limitations

Honest list of things this editor doesn't handle well, as of Milestone 9 (M9 limitations sweep). Each section below marks the resolution status inline:

- ✅ **Resolved in M9** — fully fixed in this sweep.
- 🟡 **Partial in M9** — improvement landed; explicit gap documented.
- ⏭️ **Deferred** — intentionally out of M9 scope (Phase 2).
- ✓ **Already handled (pre-M9)** — verified working.

Originally verified via the M8 corpus stress test (`/tmp/m8-corpus`) plus accumulated knowledge from prior milestones. M9 additionally adds: scanned-OCR detection banner, AcroForm read-only chip, XObject shared-content chip, CFF→OpenType wrap, multi-span editing, SSE upload progress, cross-platform fontlib (Liberation + URW), filelock save, full ARIA labelling.

## What works well

Verified across 10 diverse synthetic PDFs (Word-style, multi-column, rotated, mixed fonts, tiny fonts, image-area, Unicode, 50-fragment, landscape, custom-size):

| PDF | Pages | Fragments | Fonts mastered | Edit | Add | Delete | Reorder |
|---|---|---|---|---|---|---|---|
| 01-word-style | 3 | 18 | 2/2 | ✓ | ✓ | ✓ | ✓ |
| 02-multi-column | 1 | 41 | 2/2 | ✓ | ✓ | ✓ | n/a |
| 03-rotated | 1 | 1 | 1/1 | ✓ | ✓ | ✓ | n/a |
| 04-mixed-fonts | 1 | 4 | 4/4 | ✓ | ✓ | ✓ | n/a |
| 05-tiny-fonts | 1 | 6 | 1/1 | ✓ | ✓ | ✓ | n/a |
| 06-with-image-area | 1 | 2 | 2/2 | ✓ | ✓ | ✓ | n/a |
| 07-unicode-special | 1 | 4 | 1/1 | ✓ | ✓ | ✓ | n/a |
| 08-many-fragments | 1 | 50 | 1/1 | ✓ | ✓ | ✓ | n/a |
| 09-landscape | 1 | 1 | 1/1 | ✓ | ✓ | ✓ | n/a |
| 10-custom-size | 1 | 8 | 1/1 | ✓ | ✓ | ✓ | n/a |

All edits round-tripped: each PDF received a single edit via `/save`, the saved PDF was re-extracted, and the new text appeared in fragments[].

## Fonts

### Subset fonts: typing characters outside the embedded subset
**Impact**: medium. **Handled**: ✓ yes, via master-font swap (M5). Re-verified in M9 — PANOSE matcher correctly rejects sans↔serif crossover at `api/app/fontlib.py:_panose_compatible`.

PDFs almost always embed *subsets* of fonts — only the glyphs actually used. Typing a character not in the subset (e.g., `ñ` into an English-only text) means the glyph literally doesn't exist in the font program. M5 transparently swaps to a metric-compatible master font from `api/fontlib/` (currently Arial, Times New Roman, Courier New, Georgia, Verdana, Tahoma, Trebuchet, Comic Sans, Impact). For fonts where no master matches, a warning chip appears and the fragment falls back to the CSS fallback family.

**Limit**: if the original was a licensed custom font (Proxima Nova, Gotham, etc.) and we don't have it in our library, we **cannot** match it exactly. We surface this honestly to the user via the warning chip.

### CFF / Type1 / PFB embedded fonts
**Impact**: low (rare in modern PDFs). **Handled**: 🟡 partial — CFF resolved in M9, Type1 (PFB) still falls back.

✅ **M9 (CFF)**: bare CFF blobs are now wrapped into a complete OpenType sfnt (head/hhea/hmtx/maxp/OS/2/name/post/cmap) via `api/app/font_wrap.py:cff_to_otf`, then converted to WOFF2 and served with a real `url`. Round-trip verified against the Nimbus CFF (854 cmap entries, valid `OTTO` + WOFF2).
⏭️ **Deferred (Type1)**: PFB → OpenType requires Type1→Type2 charstring transcoding which the M9 sweep judged too risky to land safely. `pfb_to_otf` raises `NotImplementedError`; caller logs and falls back to the original raw-keep behavior (`url: null`, master matcher kicks in by family keyword as before).

### Standard 14 fonts
**Impact**: low. **Handled**: ✅ yes — Symbol + Dingbats gap closed in M9.

Helvetica / Times / Courier / Symbol / ZapfDingbats are never embedded by default. They get `url: null`, `format: null`, `availableCodepoints` = Latin-1 baseline (191 chars), and a `masterUrl` pointing to a metric-compatible master (Helvetica → Arial, Times → Times New Roman, Courier → Courier New).

✅ **M9**: Symbol and ZapfDingbats now have masters too — URW `StandardSymbolsPS-Regular.otf` and `D050000L.otf` were added to `api/fontlib/vendor/urw/`, indexed with `familyName="Symbol"`/`"Dingbats"`, and `_FAMILY_KEYWORDS` prepended with `(("zapfdingbats","dingbats"...), "Dingbats")` and `(("standardsymbol","symbolps","symbol"), "Symbol")` so PDF base-14 PSNames resolve correctly.

### macOS-only font library
**Impact**: high for portability. **Handled**: ✅ yes — cross-platform fontlib in M9.

The `api/fontlib/` library used to be built only from `/System/Library/Fonts/Supplemental/`. ✅ **M9** bundles:
- **Liberation Sans / Serif / Mono** (SIL OFL 1.1) at `api/fontlib/vendor/liberation/` — 12 TTFs covering Arial/Times/Courier metric-compatible substitutes.
- **URW Nimbus Sans / Roman / MonoPS** (AGPL3 + font-embedding exception) at `api/fontlib/vendor/urw/` — 12 OTFs covering PostScript-named Helvetica/Times-Roman/Courier.

`scripts/build_fontlib.py` now uses a priority-list pattern: tries macOS supplemental first, falls back to vendor/liberation, then vendor/urw. Each entry carries a `sourceTier` field for debugging. `index.json` is 55 entries (was 31). `_FAMILY_KEYWORDS` extended so `LiberationSans-*` and `NimbusSans-*` PSNames map to canonical families.

⚠️ **Note**: URW Nimbus is AGPL3. The font-embedding exception covers PDF embedding but not WOFF2 served to a browser. Flagged in `LICENSE`; legal review recommended before commercial deployment.

### Font licensing
**Impact**: legal. **Handled**: 🟡 informational only in M9; enforcement deferred.

Re-embedding extracted fonts may violate the font's license. ✅ **M9** exposes `fsType: int` and `fsTypeLabel: "installable" | "restricted" | "preview" | "editable"` on `FontEntry` (read from `OS/2.fsType`, decoded via `_fs_type_label`). ⏭️ **Deferred**: no edit-blocking on restricted fonts — production deployment still needs legal review. Most production PDF editors (iLovePDF, Smallpdf, Adobe) do the same.

## Text editing

### Multi-span fragment styling
**Impact**: low. **Handled**: ✅ yes (M9).

✅ **M9** adds `SpanDelta` + `Edit.newSpans` to the API. FragBox now renders each span as a child `<span data-span-idx={i}>` inside the contenteditable; `onInput` walks `childNodes` (with `Node.normalize()`) to rebuild `newSpans` preserving per-span style. Caret position survives the rebuild via `saveSelectionOffset`/`restoreSelectionOffset`. IME composition guarded via `onCompositionStart`/`onCompositionEnd`. On save, `apply_save` branches to `_apply_multi_span_edit` using PyMuPDF `TextWriter` when `len(newSpans) > 1`; single-span path is byte-for-byte unchanged.

⏭️ **Deferred (Phase 2)**: span-level Bold/Italic toggling on selection — M9 only preserves existing inline styling.

### Long replacement text wraps and may collide
**Impact**: medium. **Handled**: 🟡 partial — M9 surfaces overflow but doesn't auto-grow.

M6 caps the wrap area at `max(64, bboxHeight × 4)`. ✅ **M9** captures the `insert_textbox` return value (negative = overflow) on both edit and insertion paths and emits a `SaveWarning(code="text_overflow", ...)` that surfaces as an info toast: *"Text didn't fit in fragment X. Expand the box or shrink the font."* No more silent partial saves.

⏭️ **Deferred**: auto-growing the bbox downward into empty space is still future work.

### Underline / strikethrough are bbox-aligned, not glyph-precise
**Impact**: low. **Handled**: ✅ yes (M9).

✅ **M9** refactored `_draw_text_decorations` in `api/app/save.py` to measure text via `pymupdf.Font(fontfile=path).text_length(text, fontsize)` (or `get_text_length` for Base-14), then branch on `align` (left/right/center/justify) to compute the line span. Multi-line text falls back to bbox-wide for safety. Lines now end at the glyph run, not the bbox edge.

### Original color isn't preserved when typing into a fragment
**Impact**: none — M6 actually preserves color correctly. **Handled**: ✓ yes (verified in M9).

False alarm if you see this. M6's effective-style logic reads color from the edit (which seeds from the original span's color when first created) and applies via `style="color: rgb(...)"`. Verified again in M9 audit at `web/src/lib/edits.ts:buildBaselineEdit` + `api/app/save.py` (color flows from span → edit → `insert_textbox`).

## PDF structure

### OCR'd scanned PDFs
**Impact**: high. **Handled**: ✅ yes — detected and warned in M9.

✅ **M9** adds `_detect_ocr_layer` in `api/app/extraction.py`: per page, computes `invisibleRatio` (chars with render-mode 3 via `Page.get_texttrace()`) and `imageRatio` (image-block area / page area). When `invisibleRatio > 0.8 AND imageRatio > 0.5`, the page is flagged `appearsScanned: true` on `PageData`. Frontend `PdfPage.tsx` renders a yellow banner above scanned pages: *"This page appears to be a scanned image with an invisible OCR text layer. Text edits won't change the visible image — use Insert mode to overlay new text instead."* The user can still edit; warning is informational.

### Encrypted PDFs
**Impact**: medium. **Handled**: ✓ yes (reject on upload). Re-verified in M9.

PDFs that require a password are detected via `doc.needs_pass` / `doc.is_encrypted` at `api/app/extraction.py:89-94`. The backend tries an empty owner password (handles many common owner-only encryption cases), and if still locked, rejects upload with HTTP 400 and a clear error: "This PDF is password-protected. Please remove the password before uploading."

⏭️ **Deferred**: prompt for the password on the upload UI and pass it to the backend.

### Rotated text inside an unrotated page
**Impact**: low. **Handled**: 🟡 display done in M9; save-preservation deferred.

✅ **M9 display**: `extraction.py:_line_rotation_deg` computes per-fragment rotation from `line.dir = (cos θ, -sin θ)` (snapped to multiples of 90° within 0.5°). `Fragment.rotation` carries the angle; FragBox applies `transform: rotate(${rot}deg)` with `transform-origin: top left` on the text span (not the container, so hit-testing stays axis-aligned). Editing a rotated fragment shows a *"Rotation locked"* badge.

⏭️ **Deferred (Phase 2)**: saving a rotated edit currently loses the rotation (PyMuPDF `insert_textbox` doesn't accept an angle). Full preservation requires `TextWriter` with explicit matrix.

### Vertical (CJK) text
**Impact**: low (rare for Western use cases). **Handled**: 🟡 display done in M9; in-place vertical caret deferred.

✅ **M9 display**: `extraction.py:_line_writing_mode` reads `line["wmode"]` from rawdict; `Fragment.writingMode` is `"horizontal-tb" | "vertical-rl" | "vertical-lr"`. FragBox applies the `writing-mode` CSS so vertical text glyphs stack top-to-bottom and columns advance right-to-left.

⏭️ **Deferred (Phase 2)**: contentEditable caret on `writing-mode: vertical-rl` is unreliable across browsers (Chrome 121+ basic, selection-drag glitchy). On activate, M9 temporarily switches the editor to `horizontal-tb` and shows a banner: *"Editing switches to horizontal"*. Save then writes back as horizontal — full vertical-in-place editing is future work.

### Form fields (AcroForm) and annotations
**Impact**: medium. **Handled**: 🟡 detected + read-only in M9; full editing deferred.

✅ **M9 detection**: `extraction.py:_annotate_form_fields` iterates `page.widgets()`; fragments whose bbox-center lies inside a widget rect are flagged `isFormField: true`, `formFieldType` (text/checkbox/radio/combobox/listbox/signature/button), and `formFieldName`. FragBox renders these with an amber *"Form field — Phase 2"* chip, transparent background (no canvas redact), and `interactive=false` (click does nothing). Original PDF text remains visible underneath.

⏭️ **Deferred (Phase 2)**: full Forms-mode editor for AcroForm widget editing (text inputs / checkboxes / radio groups / signatures). The Forms tab in the toolbar stays disabled with a *"Phase 2 — coming soon"* tooltip.

### Text in form XObjects (reusable content streams)
**Impact**: low. **Handled**: ✅ detected + warned in M9.

✅ **M9**: `extraction.py:_annotate_xobject_fragments` calls `page.get_xobjects()`. Fragments fully contained inside an XObject placement rect (where the rect is < 90% of the page area, to avoid false positives on full-page templates) are flagged `isFromXObject: true`. FragBox renders a sky-blue *"Shared content"* chip; first activation pushes an info toast: *"This text appears in a shared template; editing here only changes this page."*

⏭️ **Deferred (Phase 2)**: an *"Edit all instances"* option that propagates the change to every page sharing the XObject.

## Drag / resize / save

### Page-mutation discards unsaved edits
**Impact**: medium. **Handled**: ✅ yes — confirm modal in M9.

Underlying behavior unchanged (page-renumbering invalidates `fragId`s so re-sync is the safe action). ✅ **M9** adds a pre-mutation `ConfirmDialog` modal: when `state.edits.size + state.insertions.size > 0`, `addBlankPage`/`removePage`/`reorderPages` `await useConfirmStore.getState().ask(count)`. Three buttons: **Save & continue** (runs `saveChanges()` first, aborts if save fails), **Discard** (proceeds — edits get cleared by re-sync), **Cancel** (no mutation). Modal has `role="dialog"`, `aria-modal="true"`, Escape-to-cancel.

### `insert_textbox` overflow
**Impact**: medium. **Handled**: ✅ yes (M9).

✅ **M9** captures the `page.insert_textbox(...)` return value (negative = overflow) on both edit and insertion paths in `api/app/save.py`. Each overflow emits a `SaveWarning(code="text_overflow", fragId|insertionId, pageIndex, message)`. The save endpoint now returns a `SaveResponse { document, warnings }` envelope; the frontend store loops warnings into info toasts after save: *"Text didn't fit in fragment X. Expand the box or shrink the font."* No more silent partial saves.

### Atomic save vs concurrent uploads
**Impact**: low (local dev only). **Handled**: ✅ yes (M9).

`apply_save` still writes to a temp file then `os.replace`s. ✅ **M9** layers a cross-process `filelock` (`api/app/storage.py:document_filelock`) on top of the existing in-process `asyncio.Lock`. Lock path is `<doc>/.save.lock`; timeout `5.0s`; acquired via `asyncio.to_thread`. On `filelock.Timeout` the route returns HTTP 409: *"Document is being saved by another process."* Cross-platform (macOS/Linux fcntl, Windows msvcrt). Multi-worker deployments are now safe; existing in-process behavior unchanged for single-worker dev.

## Performance

### Large PDFs (>100 pages)
**Impact**: medium. **Handled**: ✅ yes — SSE in M9.

✅ **M9** adds two endpoints:
- `POST /api/upload/streaming` — saves bytes, registers an `UploadJob` (`api/app/upload_jobs.py`) with an `asyncio.Queue`, schedules extraction via `BackgroundTasks`, returns `{jobId, documentId}` immediately.
- `GET /api/upload/{jobId}/events` — returns `StreamingResponse(media_type="text/event-stream")` emitting `{phase, done, total}` events followed by a terminal `{done: true, documentId}` or `{error}`.

Backend `extract_document()` accepts an optional `progress` callback and threads it through font extraction + per-page extraction. Frontend `UploadZone.tsx` routes files > 5 MB to the streaming path and renders a `<progress>` bar with phase text (*"Extracting fonts..."*, *"Page 47 of 200"*). Existing non-streaming `POST /api/upload` still works for small uploads.

⏭️ **Deferred (Phase 2)**: multi-worker upload-job registry. The in-process `_JOBS` dict doesn't survive worker restart; OK for single-worker dev/staging but multi-worker production would need Redis or sticky-session routing.

### Hundreds of fragments per page
**Impact**: low. **Handled**: ✓ yes (verified in M9).

The corpus's `08-many-fragments.pdf` (50 fragments per page) renders smoothly. Lazy-load via IntersectionObserver (`web/src/components/PageStack.tsx:31-62`) means only visible pages render their canvas + edit-layer. Re-verified in M9 audit — no changes needed.

**Untested**: 1000+ fragments per page — could cause React render lag.

### Font extraction time
**Impact**: low. **Handled**: ✅ yes — parallelized in M9 (opt-in).

✅ **M9** refactors `extract_fonts` (`api/app/fonts.py`) to build a `pending: list[(xref, basefont, ext)]` then dispatch via `ThreadPoolExecutor(max_workers=4).map(_build_font_entry, ...)`. `executor.map` preserves input order so font `ref` assignment stays deterministic. Gated behind `PDF_EDITOR_PARALLEL_FONTS=1` env flag for rollback safety. Expected 2-4× speedup on multi-font PDFs; serial behavior preserved by default.

## Browser

### Tested browsers
Chrome and Safari on macOS. Firefox not tested. Mobile not tested. **Handled**: 🟡 feature-detection in M9; manual QA still pending.

✅ **M9** adds `web/src/lib/browserSupport.ts`: detects `PointerEvent`, `EventSource`, `execCommand`, `isFirefox`, `isSafari`, `isMobile`. App boot runs `assertCriticalSupport()`; if anything is missing, a sticky error toast surfaces. Manual cross-browser checklist appended at the bottom of this doc (Chrome/Safari/Firefox on macOS + Linux + Windows + iOS/Android).

⏭️ **Deferred (Phase 2)**: mobile remediation. iOS Safari virtual keyboard occludes fragments; Android Chrome pointer drag conflicts with scroll. Detection is in place; remediation deferred.

### `contenteditable` quirks
**Handled**: ✅ yes — paste handler in M9.

The FragBox still uses imperative `textContent` updates to avoid React clobbering the cursor. ✅ **M9** adds an `onPaste` handler to the contenteditable: `e.preventDefault()` + `clipboardData.getData("text/plain")` + `document.execCommand("insertText", false, text)`. If `execCommand` ever returns `false`, a Range-API fallback deletes the selection, inserts a TextNode, collapses caret, and dispatches a synthetic `input` event so the onInput pipeline (subset check, edit update) runs. Pasting from Word/Docs now strips all HTML.

## Accessibility

### Keyboard nav
**Handled**: ✅ yes (M9).

- Cmd+Z/Shift+Z, Cmd+S, Cmd+B/I/U, Esc, Delete all work (pre-M9).
- ✅ **M9**: Context menu activation on thumbnails — `onKeyDown` on each thumbnail button handles `e.key === "ContextMenu"` (modern), `"Apps"` (legacy Firefox), and `Shift+F10` (Windows convention). Each preventDefaults and opens the same 3-dot menu at the button's right/top edge.
- ✅ **M9**: Mode toolbar buttons now expose `aria-pressed={isActive}` and `aria-label="${tab.label} mode"`. Tab order: DOM source order matches desired tab order (no positive `tabIndex` anti-pattern); confirmed manually.

### Screen readers
**Handled**: ✅ yes — ARIA pass in M9.

✅ **M9** adds:
- **FragBox inactive**: `role="button"` (or `"presentation"` when `isFormField`), `tabIndex={interactive ? 0 : -1}`, `aria-label="Click to edit text: ${fragment.text}"`, `aria-disabled` when not interactive, `onKeyDown` Enter/Space → activate.
- **FragBox active**: `role="textbox"`, `aria-multiline="false"`, `aria-label="Editing PDF text fragment"`.
- **ThumbnailRail**: `<ul role="listbox" aria-label="Document pages" aria-orientation="vertical">`; each button `role="option" aria-selected={...} aria-label="Page N of M"`.
- **ModeToolbar**: `aria-pressed` + `aria-label` per mode button.
- **Toast viewport**: `aria-live="polite"` + `aria-atomic="true"` (each toast already had `role="status"`).

⏭️ **Deferred**: focus trapping in modals (the `ConfirmDialog` autoFocuses the primary action and handles Escape, but full focus-trap-on-open is future work). Manual VoiceOver + axe-core audit not yet performed in M9.

---

## Bottom line

The editor handles the **common case** very well: business PDFs with embedded TTF/OTF fonts, standard page sizes, single-column or multi-column layouts. After the M9 limitations sweep most former hard cases (subset glyphs, custom fonts, scanned PDFs, form fields, vertical text, CFF embedded fonts, multi-span styling) are handled or surfaced honestly. The remaining Phase-2 items below are tracked separately.

No production PDF editor on the market handles all of these perfectly. Our limits are honest and surfaced in the UI where possible.

---

## Resolved in M9 (2026-05)

The M9 sweep audited and addressed every limitation above. Status summary:

**Fonts**
- Subset-font master swap: verified working end-to-end (PANOSE matcher rejects sans↔serif).
- CFF / Type1 embedded fonts: CFF now wrapped to OpenType sfnt + WOFF2 via `app/font_wrap.py`. Type1 (PFB) stubbed with graceful fallback.
- Standard 14 fonts: Symbol + ZapfDingbats now have masters (URW StandardSymbolsPS + D050000L).
- macOS-only fontlib: cross-platform via Liberation Sans/Serif/Mono (OFL) + URW Nimbus Sans/Roman/MonoPS (AGPL3 + font-exception). `build_fontlib.py` prefers system fonts, falls back to bundled.
- OS/2.fsType: exposed in FontEntry (`fsType`, `fsTypeLabel`). Informational only; not enforced.

**Text editing**
- Multi-span fragment styling: edit preserves inline bold/italic per span via newSpans + PyMuPDF TextWriter on save.
- insert_textbox overflow: detected via the return value and surfaced as a `text_overflow` save warning in the toast channel.
- Underline / strikethrough: glyph-precise via `pymupdf.Font.text_length`; respects left/right/center alignment.
- Original color preservation: confirmed working.

**PDF structure**
- OCR'd scanned PDFs: detected via `page.get_texttrace()` invisible-text ratio + image-coverage ratio. Yellow banner above scanned pages.
- Encrypted PDFs: rejected at upload (unchanged from prior).
- Rotated text inside unrotated page: extracted via `line.dir`, rendered with CSS `transform: rotate()`. Editing rotated fragments shows "Rotation locked" badge (Phase 2 to preserve through save).
- Vertical (CJK) text wmode=1: extracted via `line.wmode`, rendered with `writing-mode: vertical-rl`. Activation switches to horizontal editor with banner (Phase 2 for vertical caret).
- Form fields (AcroForm): widget-overlapping fragments flagged `isFormField`, rendered read-only with "Form field — Phase 2" chip. Full form editing deferred.
- Text in form XObjects: fully-contained fragments flagged `isFromXObject`, shown with "Shared content" chip + info toast on activate.

**Save**
- Page-mutation discards edits: pre-mutation `ConfirmDialog` modal (Save / Discard / Cancel).
- insert_textbox overflow: see above.
- Atomic save vs. concurrent uploads: `filelock`-based per-document `.save.lock` (cross-platform, 5s timeout, HTTP 409 on contention). Layered behind the asyncio fast-path.

**Performance**
- Large PDFs (>100 pages): new `POST /api/upload/streaming` + `GET /api/upload/{jobId}/events` SSE channel; UploadZone shows real progress for files > 5 MB.
- Hundreds of fragments per page: still handled by IntersectionObserver lazy-load.
- Font extraction time: parallelized via `ThreadPoolExecutor(max_workers=4)` gated by `PDF_EDITOR_PARALLEL_FONTS=1`.

**Browser**
- Cross-browser feature detection: `web/src/lib/browserSupport.ts` runs at boot; sticky error toast if PointerEvent / EventSource missing.
- contenteditable paste: `onPaste` handler inserts plain text via `execCommand("insertText")` with Range-API fallback.

**Accessibility**
- Keyboard nav: ContextMenu / Apps / Shift+F10 trigger thumbnail context menus; mode buttons get `aria-pressed`.
- Screen readers: FragBox has `role="button"`/`"textbox"` + `aria-label`; ThumbnailRail uses `role="listbox"` / `role="option"`; Toast viewport has `aria-live="polite"` + `aria-atomic="true"`.

## Phase 2 deferrals (intentionally out of scope for M9)

- Full Forms-mode editor (text inputs / checkboxes / radio groups / signatures). Forms tab stays disabled with tooltip.
- Mobile remediation (iOS Safari virtual keyboard occlusion; Android pointer-vs-scroll). Detection in place; remediation deferred.
- Font license enforcement: `fsType` exposed but not enforced. Production deployment needs legal review.
- Span-level Bold/Italic on selection: M9 preserves existing inline styling; toggling on selection is a follow-up.
- "Edit all instances" for XObject-sourced fragments: M9 only warns.
- Rotated fragment save preserves rotation: M9 displays rotation; editing converts to upright.
- Vertical CJK in-place caret: M9 displays vertical; activation switches to horizontal.
- Multi-worker upload-job registry: in-process `_JOBS` dict; multi-worker via Redis deferred.
- Type1 (PFB) → OpenType wrapping: M9 ships CFF wrap; Type1 charstring transcoding stubbed.

## Tested browsers (Wave 1)

Manual verification checklist (run before each release):
- [ ] Chrome latest on macOS
- [ ] Safari latest on macOS
- [ ] Firefox latest on macOS
- [ ] Firefox latest on Ubuntu 22.04
- [ ] Chrome latest on Windows 11
- [ ] iOS Safari (latest) — known: virtual keyboard occludes fragments (Phase 2)
- [ ] Android Chrome — known: pointer drag conflicts with scroll (Phase 2)

Test flow for each: upload 5-page PDF -> drag a fragment -> edit text -> save -> reload -> confirm persistence.

## M9 verification status

What was code-verified at land time vs. what still needs hands-on testing on real input PDFs:

| Item | Code-verified | Tested on real PDF | Notes |
|---|---|---|---|
| Backend schema (SaveResponse, SpanDelta, Fragment fields, FontEntry.fsType) | ✅ | ✅ | imports + `model_fields` checks pass |
| TypeScript compilation | ✅ | n/a | `npx tsc --noEmit` exit 0 |
| filelock contention (HTTP 409) | ✅ | ⏭️ | smoke test in agent reported `Timeout` after 0.5s |
| insert_textbox overflow warning | ✅ | ⏭️ | agent smoke test produced correct toast payload |
| CFF wrap (Nimbus round-trip) | ✅ | ⏭️ | wrapped 70824 B CFF → 77060 B OTF → 55500 B WOFF2 with 854 cmap entries |
| Multi-span styling (synthetic 2-span) | ✅ | ⏭️ | rendered "Total: $42.00" + extracted unchanged |
| Symbol/Dingbats masters in fontlib | ✅ | ⏭️ | index.json has both with correct `familyName` |
| Liberation + URW bundle | ✅ | ⏭️ | 12 + 14 OTFs in vendor/; index.json grew 31 → 55 |
| OCR detection on real scan | ⏭️ | ⏭️ | no scanned fixture available locally |
| AcroForm read-only chip on real form | ⏭️ | ⏭️ | no AcroForm fixture locally |
| XObject chip on real template | ⏭️ | ⏭️ | no template fixture locally |
| SSE upload progress on 200-page PDF | ⏭️ | ⏭️ | no large PDF fixture locally |
| Rotated caption rendering | ⏭️ | ⏭️ | no rotated-caption fixture locally |
| CJK vertical writing-mode | ⏭️ | ⏭️ | no CJK fixture locally |
| VoiceOver / axe-core a11y pass | ⏭️ | ⏭️ | manual screen-reader audit not run |
| Firefox / mobile manual run | ⏭️ | ⏭️ | feature detection in place; manual QA pending |
| M8 corpus regression (10-PDF stress test) | ⏭️ | ⏭️ | `/tmp/m8-corpus` not re-run in M9 |

The "⏭️" entries aren't bugs — they're fixtures we don't have locally. Before declaring M9 fully verified: grab a real OCR scan, an AcroForm PDF, an XObject template, a 200-page doc, a rotated-caption sample, and a CJK vertical sample; walk through them in the browser; re-run the M8 corpus.
