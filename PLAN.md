# PDF Editor — Architecture & Implementation Plan

A web-based WYSIWYG PDF editor in the style of iLovePDF's "Edit PDF". Upload any PDF, every text fragment is outlined with a dotted blue box, click any box to edit text in the original font, drag boxes to move them, change font/size/color in a sidebar, save back to a real PDF.

---

## 1. The honest truth, up front

This is a **hard** project. Every commercial PDF editor — iLovePDF, Smallpdf, Acrobat Web, Sejda — has the same dirty secret: **none of them reliably preserve fonts when you edit text**. They preserve position and approximate appearance, but font matching after editing is the consistent failure mode across the industry. The reasons are structural to PDF:

1. PDFs have **no concept of paragraphs, lines, or even words.** Text is positioned glyph-by-glyph with arbitrary transforms. "Editable text boxes" must be reconstructed by heuristic clustering.
2. PDF fonts are **almost always subsetted** — embedded with only the glyphs the document actually uses. Type a character the subset doesn't include and the glyph literally does not exist in the font program.
3. PDFs use **custom encodings and ToUnicode CMaps**, including ligatures like `glyph 0xA1 → "fi"`. Reversing this mapping during editing is ambiguous.
4. Font formats inside PDFs (Type1, CFF, CIDFontType0C) **are not directly browser-loadable**. They must be wrapped/converted to OTF/TTF.

We will build a real editor that handles the common case well (Arial-ish text in business documents) and degrades gracefully on the hard cases (subsetted custom fonts, ligatures, CJK). We will not pretend we can match Acrobat on a typographically rich InDesign export — and neither does iLovePDF.

---

## 2. Architecture: Hybrid Pattern (PDF.js client + PyMuPDF server)

Four established patterns exist:

| Pattern | Used by | Verdict |
|---|---|---|
| A. PDF.js canvas + text layer overlay | PDF.js viewer, many OSS clones | Text-layer fragmentation makes editing painful |
| B. pdf2htmlEX full HTML conversion | Some legacy tools | Highest visual fidelity, but DOM is unworkable for editing |
| C. SVG rendering | Mostly deprecated (PDF.js dropped SVG backend in v3) | Editing native SVG `<text>` is awkward |
| D. Server-rendered raster + DOM overlay | **iLovePDF, Smallpdf, Sejda** | Best UX, highest server cost (raster every page) |
| E. **Hybrid: PDF.js canvas + server-extracted edit data + DOM overlay** | — | **Our choice** |

**Why Pattern E:** It gives us iLovePDF-quality editing UX without the cost of rasterizing every page on our server. PDF.js handles the hard rendering work (fonts, vector graphics, transparency, blending) in the browser using the GPU. Our server does one expensive thing per upload: extract structured text + fonts with PyMuPDF, then is mostly idle until save. We can upgrade to Pattern D later if we ever need pixel-perfect server-side rendering.

```
┌────────────────────── BROWSER ──────────────────────┐
│                                                     │
│  ┌──────────────────────────────────────────────┐   │
│  │ <canvas>  ← PDF.js rendered page (raster)    │   │
│  └──────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────┐   │
│  │ <div.edit-layer>  ← absolute-positioned       │   │
│  │   <div.frag contenteditable>...</div>  × N    │   │
│  │   dotted-blue outlines, click-to-edit         │   │
│  └──────────────────────────────────────────────┘   │
│                                                     │
│  <aside.sidebar>  font/size/color/align controls    │
│                                                     │
└──────────────────────┬──────────────────────────────┘
                       │ JSON (text deltas, bbox moves)
┌──────────────────────▼──────────────────────────────┐
│                      SERVER                         │
│  - Upload: PyMuPDF extracts blocks/lines/spans,     │
│           extracts embedded fonts, converts to WOFF2│
│  - Save:  PyMuPDF redacts originals,                │
│           inserts edited text in matched font       │
└─────────────────────────────────────────────────────┘
```

---

## 3. Tech stack

### Frontend
- **React 18 + Vite + TypeScript** — standard, fast, easy to recruit for.
- **pdfjs-dist (≥5.x)** — Apache-2.0. Renders the canvas background. We skip its built-in text layer and build our own from server JSON.
- **Zustand** — fragment edit state. Lighter than Redux, fine for this scope.
- **HarfBuzz.js (harfbuzzjs)** — optional, for client-side text shaping with kerning/ligatures when typing in a master font.
- **fontkit** or **opentype.js** — only if we do client-side font conversion (CFF→OTF). Server-side is preferred.
- **No pdf-lib for save.** It cannot cleanly remove original content streams — the "draw a white rect over the original" trick fails for accessibility and searchability. Save round-trips to the server.

### Backend
- **FastAPI (Python 3.12)** — async, type-safe, easy to deploy.
- **PyMuPDF (fitz)** — the core extraction + write-back library. Best-in-class text grouping (`page.get_text("rawdict")` returns `blocks → lines → spans → chars` with font/size/color/bbox already clustered).
- **fontTools** — convert extracted CFF/Type1 to browser-loadable OTF/WOFF2, manage subset merging when users type characters not in a subset.
- **Object storage** (S3 / R2 / Minio for local dev) — store original PDF, extracted fonts, and edit JSON keyed by document ID.

### License & deployment (locked)
- **PyMuPDF (AGPL-3.0) confirmed.** Project is open-source / personal / internal, so AGPL is fine.
- **Local development only.** Storage: local filesystem under `./storage/{documentId}/`. No S3, no object store. Dockerization deferred to Phase 3.
- **MVP scope (locked):** edit existing text + insert new text/shapes/images. This is a bigger MVP — see Section 8 for revised milestones.

---

## 4. The data model

Per uploaded document, the server stores:

```jsonc
// document.json
{
  "documentId": "uuid",
  "pageCount": 12,
  "pages": [
    {
      "index": 0,
      "widthPt": 612,         // PDF user units (1/72 inch)
      "heightPt": 792,
      "fragments": [
        {
          "id": "p0-f0",
          "bbox": [72, 108, 540, 124],   // [x0, y0, x1, y1] in PDF coords (origin: bottom-left)
          "text": "Project Completion Report",
          "spans": [
            {
              "text": "Project Completion Report",
              "fontRef": "f0",           // → fonts[].ref
              "size": 18.0,
              "colorRgb": [0.1, 0.1, 0.1],
              "bold": true,
              "italic": false
            }
          ]
        }
        // ...
      ]
    }
  ],
  "fonts": [
    {
      "ref": "f0",
      "psName": "Helvetica-Bold",
      "subsetTag": "ABCDEF",            // null if not subsetted
      "fsType": 8,                       // OS/2 embedding bits
      "format": "otf",                   // ttf | otf | (converted from cff/pfb)
      "url": "/api/doc/{id}/fonts/f0.woff2",
      "masterUrl": "/api/doc/{id}/fonts/f0-master.woff2",  // null if no master found
      "availableCodepoints": [/* sorted list */],
      "metrics": { "ascent": 728, "descent": -210, "unitsPerEm": 1000, "italicAngle": 0, "capHeight": 718, "xHeight": 523, "stemV": 80 },
      "panose": [2,11,7,4,2,2,2,2,2,4]
    }
  ]
}
```

Fragments come from PyMuPDF's **line-level grouping** (`page.get_text("rawdict")["blocks"][i]["lines"]`). Each `line` is one editable box. Within a line, multiple `spans` carry styling (a line with mixed bold/regular text is one fragment with two spans).

The dotted-blue outline UX maps **one frag = one outlined box**. Mixed-styling within a box renders as styled segments in the contenteditable.

---

## 5. The pipelines

### 5.1 Upload pipeline (server, ~1–3s for typical PDFs)

```
POST /api/upload  (multipart, PDF binary)
  │
  ▼
1. Save PDF to object storage; assign documentId
2. PyMuPDF open(doc)
3. For each page:
     page.get_text("rawdict")  →  blocks/lines/spans/chars
     group into fragments (one per line in MVP)
     normalize coordinates to top-left origin OR keep PDF coords
4. Walk xref table, doc.extract_font() for each unique font:
     a. dedupe by (psName, subsetTag, length)
     b. if ext = "ttf"|"otf": pass through, convert to WOFF2 (fontTools)
     c. if ext = "cff" / Type1C: wrap as OpenType sfnt with synthesized
        head/hhea/hmtx/maxp/name/OS/2/post/cmap tables; convert WOFF2
     d. if ext = "pfb" (Type1): tx -t1 -cff → wrap as OTF → WOFF2
     e. for each font, identify "master" by:
        - strip subset prefix
        - lookup in local font library (Google Fonts mirror + system)
        - PANOSE + metric distance tiebreaker
        - if master found, fetch & store as WOFF2
     f. compute availableCodepoints from CMap
5. Store fonts and document.json
6. Return { documentId }
```

### 5.2 Edit session (browser)

```
GET /api/doc/{id}              →  document.json
GET /api/doc/{id}/pdf          →  original PDF bytes
GET /api/doc/{id}/fonts/*.woff2 →  fonts (with proper CORS)

1. pdfjsLib.getDocument(pdfBytes).promise
2. For each page:
     page.render({ canvasContext, viewport })   // pixel background
3. Register every font via:
     await new FontFace(`pdfFont_${docId}_${fontRef}`,
                        `url(${woff2Url}) format('woff2')`).load()
     document.fonts.add(face)
     // and the master variant if available
4. Render edit-layer:
     fragments.map(f => <FragBox
        style={{
          position:"absolute",
          left, top, width, height,   // viewport coords
          fontFamily: `pdfFont_${docId}_${f.spans[0].fontRef}`,
          fontSize: f.spans[0].size * viewport.scale,
          color: rgbCss(f.spans[0].colorRgb),
          outline: "1px dashed #4a90e2"
        }}
        contentEditable={isActive}
     />)
5. On focus:  clearRect on canvas under the bbox → no double-text flicker
6. On keystroke: check codepoint in availableCodepoints
     - if present: continue with subset font
     - if absent + master available: swap CSS family to master font
       transparently (same metrics, no visible jump)
     - if absent + no master: show inline picker "Use [Liberation Sans]?"
7. On drag/resize: pointer events; convert px → PDF pt via viewport.scale
8. On Save:  diff against original; POST deltas
```

### 5.3 Save pipeline (server)

```
POST /api/doc/{id}/save
  body: [
    { fragId, originalBBox, newBBox, newText, newSpans }
  ]
  │
  ▼
1. Open original PDF with PyMuPDF
2. For each delta:
     page.add_redact_annot(originalBBox, fill=(1,1,1))
     page.apply_redactions()    // removes from content stream + raster
     page.insert_textbox(
         newBBox,
         newText,
         fontfile = stored_font_bytes_for_fragment_font,
         fontname = "F0",
         fontsize = span.size,
         color = span.colorRgb,
         align = derived_align
     )
3. If user typed glyphs not in original subset and master used:
     re-embed master font (subset down to current usage) via insert_font
4. doc.save(buf, deflate=True, garbage=4, clean=True)
5. Return new PDF
```

---

## 6. The hard problems and our approach

### 6.1 Glyph → editable-box grouping

**Use PyMuPDF's line-level grouping** as ground truth. MuPDF's extractor already clusters glyphs by baseline + horizontal proximity + font/size identity. For multi-column layouts and tables, MuPDF's blocks are reliable enough.

**MVP**: one fragment per `line` from `rawdict`. **Phase 2**: merge consecutive lines with same font/size and tight inter-line gap into paragraph fragments — better UX (less click-flutter) but trickier reflow.

**Edge cases:** rotated text (use the line's `dir` field for rotation), vertical CJK (`wmode = 1` in span), text inside form XObjects (recurse via `page.get_xobjects`). Phase 2.

### 6.2 Font fidelity (the biggest fight)

**Three-layer strategy:**

1. **Original subset font** — extracted, converted to WOFF2, registered as `@font-face`. Used as long as user types only characters in the original subset. This is **the common case** and handles 90% of edits invisibly.

2. **Master font swap** — if we identified the parent font on upload (e.g., subset `ABCDEF+Helvetica-Bold` → matches our system's Helvetica-Bold by metric+PANOSE distance), and the user types a character the subset lacks, we swap the CSS `font-family` to the master at the next keystroke. Metrics match, so no visible jump.

3. **Substitution with warning** — if no master is found (genuine custom font), we offer the closest metric match from our library (DejaVu, Liberation, Carlito/Caladea, urw-base35) and flag the run as "substituted" in the UI. User can override.

**On save**, the server subsets the *master* down to exactly the glyphs the edited text now uses, re-embeds it, and replaces the font reference in the content stream. Runs that were never edited keep the original subset untouched.

**Honest limitation:** if the original was a licensed custom font (e.g., Proxima Nova) and we don't have it in our library, we cannot match it exactly. **No editor can.** We will be transparent in the UI.

### 6.3 ToUnicode CMap reverse mapping

PyMuPDF resolves ToUnicode for us on extraction — `rawdict` strings are already Unicode. The reverse problem (Unicode → glyph) for editing is handled by:
- The browser does its own CMap lookup when rendering `@font-face` text — it uses the font's `cmap` table directly. If the font's `cmap` is intact, Unicode-in = correct-glyph-out, including ligatures via GSUB.
- Where the original used a private-use-area encoding (some old PDFs), we patch the WOFF2's `cmap` to map standard Unicode codepoints to the same glyph IDs before serving.

### 6.4 Color from getOperatorList vs from rawdict

`getTextContent()` in pdf.js does **not** include color. PyMuPDF's `rawdict` **does**. Since we extract server-side, color comes for free. We don't need to walk pdf.js's operator list.

### 6.5 The "edit clears original" flicker

When a user clicks a frag, the original text is in the rasterized canvas underneath. If we don't hide it, contenteditable text floats on top of the old text (double vision). Fix:

```js
// on frag focus
const { left, top, width, height } = frag.viewportRect;
ctx.fillStyle = "white";  // or sampled background
ctx.fillRect(left, top, width, height);
```

On blur, we don't restore — the frag is now the truth, and on next page render we paint the new state.

---

## 7. UI components (React)

```
<App>
  <TopBar />                           // file controls
  <Toolbar />                          // Annotate | Shapes | Insert | Edit Text | Forms
  <PageThumbnails />                   // left rail
  <PageCanvasStack>                    // center
    <Page>                             // per page
      <Canvas />                       // pdf.js raster
      <EditLayer>
        <FragBox />                    // outlined editable boxes
      </EditLayer>
    </Page>
  </PageCanvasStack>
  <Sidebar>                            // right rail (matches iLovePDF screenshot)
    <FontPicker />                     // Arial | 7.875 | B I U S
    <AlignControls />
    <ColorPicker />
    <LinkControl />
    <UndoRedo />
    <SaveButton />
  </Sidebar>
</App>
```

State (Zustand): `documentId`, `pages`, `fragmentsById`, `activeFragId`, `history` (undo/redo stack), `pendingSave`.

---

## 8. MVP scope and milestones

MVP includes editing existing text **and** inserting new text/shapes/images. Roughly 10–12 weeks of focused work.

### Milestone 1 — Skeleton (week 1)
- Vite + React + TS scaffold (`/web`)
- FastAPI scaffold (`/api`), local filesystem storage at `./storage/{documentId}/`
- File upload UI → `/api/upload` saves PDF, returns documentId
- pdfjs-dist renders all pages stacked, scrollable
- Left rail: page thumbnails (PDF.js `getPage(n).render` at low DPI)
- **Demo: upload any PDF, see all pages rendered with thumbnails**

### Milestone 2 — Extraction + dotted outlines (week 2)
- PyMuPDF integration, real `rawdict` extraction → `document.json`
- Edit-layer renders FragBox per line with dotted blue outline (matches iLovePDF reference screenshots)
- Coordinate math helper: PDF points ↔ viewport pixels (both directions)
- Mode toolbar (Annotate | Shapes | Insert | **Edit Text** | Forms) — only Edit Text active for now
- **Demo: every text fragment outlined like iLovePDF**

### Milestone 3 — Font extraction + WYSIWYG editing (weeks 3–4)
- `doc.extract_font()` for every font in PDF
- fontTools conversion pipeline (CFF→OTF, Type1→OTF), WOFF2 emit, served at `/api/doc/{id}/fonts/{ref}.woff2`
- Client registers fonts via `FontFace` API on document open
- Click-to-edit makes frag contenteditable; clearRect under it on the canvas to hide original
- Sidebar shows font name + size from active frag, reads from `document.json`
- **Demo: edit any text in original font, looks correct**

### Milestone 4 — Save (week 5)
- POST `/api/doc/{id}/save` with edit deltas
- Server: PyMuPDF `add_redact_annot` + `apply_redactions` + `insert_textbox` + `insert_font`
- Roundtrip: edit text → save → re-open in editor → edits persisted
- Manual QA: open output in Acrobat / Preview / Chrome PDF — verify well-formed
- **Demo: end-to-end edit and download**

### Milestone 5 — Master-font matching + substitution UX (weeks 6–7)
- Local font library: urw-base35 + Liberation + Carlito/Caladea + a curated Google Fonts mirror cached on disk
- PANOSE + metric distance matching on upload, store `masterUrl` alongside subset
- Client-side codepoint check on every keystroke; transparent swap to master when subset lacks glyph
- Substitution warning UI when no master found
- **Demo: type characters outside the subset; works seamlessly when master exists, clear UX when not**

### Milestone 6 — Drag, style controls, undo/redo (week 8)
- Drag boxes; 8-handle resize
- Bold / Italic / Underline / Strikethrough toggles applied to selected span(s)
- Color picker (current color + custom colors palette)
- Left / Center / Right / Justify alignment
- Undo/redo stack (Zustand temporal middleware)
- **Demo: feature parity with iLovePDF's Edit Text sidebar**

### Milestone 7 — Insert: new text boxes, shapes, images (weeks 9–10)
- Insert tab: text box / rectangle / ellipse / line / arrow / image upload
- Click-and-drag on page to create; instantly editable
- Shapes get stroke/fill/width controls in sidebar
- Images uploaded → stored in document storage → rendered via PDF.js + saved via `page.insert_image`
- Drag/resize handles match text frags
- Save extension: server inserts new content streams via PyMuPDF `insert_text`, `draw_rect`, `draw_oval`, `draw_line`, `insert_image`
- **Demo: build a PDF from scratch overlay on a blank uploaded PDF**

### Milestone 8 — Polish + integration (weeks 11–12)
- Page management: add blank page, delete page, reorder via thumbnail drag
- Keyboard shortcuts (Cmd+Z, Cmd+B/I/U, Cmd+S)
- Loading states, error boundaries, file-too-large guard
- Localhost smoke test on 10 real-world PDFs (Word export, LaTeX, scanned-with-OCR, InDesign, multi-column, CJK)
- Document known-broken cases
- **Demo: end-to-end usable editor**

### Phase 2 (post-MVP)
- Paragraph-level grouping (merge consecutive lines for nicer click targets)
- Annotations (highlight, ink, stamps) — leverage PDF.js editor mode
- Form field editing
- OCR layer for scanned PDFs (Tesseract or PaddleOCR)
- Real "Forms" tab (text inputs, checkboxes, radio buttons)

### Phase 3 (long-term)
- Dockerize, cloud deploy
- Rasterization farm (Pattern D) for pixel-perfect display mode
- Multi-user collaborative editing (Yjs)
- WASM PyMuPDF for offline editing

---

## 9. Risks and mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| AGPL contamination (PyMuPDF) bites us in a commercial product | Med | High | Decide license posture before milestone 3. If commercial: budget for Artifex license OR switch to pdfplumber+pikepdf. |
| Custom subset fonts have no master and look wrong after edit | High | Med | Honest substitution UI; offer "convert to outlines" option for pixel-perfect non-edited preservation. |
| pdf.js text-layer fragmentation makes our grouping look wrong | Low | Med | We're using PyMuPDF, not pdf.js, for grouping. Lower risk. |
| Browser font-loading races edit input | Low | Low | Preload all fonts during page render; show skeleton until `document.fonts.ready`. |
| Large PDFs (100+ pages) slow on upload | Med | Low | Stream extraction page-by-page; lazy-load font WOFF2 per page. |
| Rotated/vertical text rendered wrong | Med | Med | Detect on extract; render as transformed frag boxes; ship in Phase 2. |
| OCR'd scanned PDFs — user expects to edit the image | High | Low | Detect (no text content) and surface a clear "this PDF needs OCR first" message in MVP. |
| Font licensing — re-embedding someone else's licensed font | Med | Med (legal) | Respect `OS/2.fsType` bit 0x0002 (refuse) and 0x0008 (no redistribution); document terms; don't ship a font CDN. |

---

## 10. Decisions (locked)

| Decision | Choice | Implication |
|---|---|---|
| License posture | Open-source / personal / internal | PyMuPDF (AGPL) is the primary engine. No license budget needed. |
| Hosting | Local dev only | Filesystem storage at `./storage/{documentId}/`. No S3, no Docker yet. |
| Save target | In-place text replacement (iLovePDF-style) | Server uses PyMuPDF `redact + insert_textbox`. Originals not preserved as a separate layer. |
| MVP feature scope | Edit existing text + insert new text/shapes/images | 10–12 week build. Milestones 1–8. Forms and annotations are Phase 2. |

---

## 11. Why not just use \[X\]?

- **PDF.js editor mode** — only edits annotations (FreeText, ink, stamps, highlights), not existing body text. We'd have to build the body-text editing ourselves anyway.
- **pdf-lib alone** — can write text but cannot extract existing text with font info. Cannot remove original text cleanly.
- **pdf2htmlEX** — fidelity is excellent for display, but the generated HTML is impossible to edit cleanly. And no first-class write-back path.
- **PSPDFKit / Apryse WebViewer** — would solve this, but $25k–$100k+/year licensing. Worth considering if this becomes a commercial product with real customers.
- **Adobe PDF Services API** — proxies to Adobe's cloud, per-call cost, no UI. Useful for batch operations, not for an interactive editor.

---

## 12. What's actually new about this vs every other PDF editor

Nothing fundamental. We are not solving a research problem. We are assembling **PyMuPDF + pdf.js + the Web FontFace API + a real master-font matching pipeline** in a way that's missing from open-source editors today. Most OSS PDF "editors" punt on font fidelity entirely (overlays, white-out hacks). Doing the master-font matching properly — even if imperfectly — is the differentiator.

That's the plan.
