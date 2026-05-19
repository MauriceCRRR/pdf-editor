# PDF Editor

A browser-based WYSIWYG PDF editor. Upload a PDF, click any text fragment to edit it in its original font, drag and resize, restyle, add new text / shapes / images, insert / delete / reorder pages, and save back to a real PDF.

Inspired by iLovePDF's "Edit PDF" but self-hostable.

## Features

- **Click-to-edit text** preserving the original font (TTF / OTF / CFF), size, color, alignment, weight, style, underline, and strikethrough
- **Subset-font handling** — characters outside the embedded subset are filled in from a metric-compatible master via PANOSE classification
- **Multi-span styling** — bold / italic words within a fragment survive partial edits
- **Drag and resize** any text fragment; bbox round-trips cleanly through PyMuPDF
- **Insert mode** — overlay text boxes, shapes (rectangle / circle / line / arrow), and images
- **Page management** — add blank pages, delete, reorder via drag, with a confirm-on-dirty modal
- **Detection chips** for scanned-OCR pages, AcroForm fields, and shared XObject templates
- **Streaming upload progress** for large PDFs via Server-Sent Events
- **Undo / redo**, keyboard shortcuts, ARIA-labeled UI
- **Cross-platform fontlib** — Liberation Sans / Serif / Mono (OFL), URW Nimbus (AGPL3), and Inter (OFL) bundled

## Quick start

Requires Python 3.12+ and Node.js 20+.

### Backend (terminal 1)

```bash
cd api
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

### Frontend (terminal 2)

```bash
cd web
npm install
npm run dev
```

Open <http://localhost:5173>. The Vite dev server proxies `/api/*` to the backend on `:8000`.

### Fontlib (first-time, optional)

The bundled `api/fontlib/vendor/` covers Linux / Windows out of the box. On macOS, run the build script to also register the system supplemental fonts:

```bash
cd api && .venv/bin/python scripts/build_fontlib.py
```

## Layout

```
api/          FastAPI backend (Python)
api/app/      Application code — routes, models, extraction, save, fonts
api/fontlib/  Font masters (Liberation OFL, URW AGPL3, Inter OFL)
api/scripts/  Build / utility scripts
web/          Vite + React + TypeScript frontend
storage/      Per-document uploads + extracted data (runtime, gitignored)
```

## API

| Method | Path | Notes |
|---|---|---|
| GET | `/api/health` | liveness |
| POST | `/api/upload` | multipart PDF ≤ 50 MB |
| POST | `/api/upload/streaming` | starts a job, returns `{jobId, documentId}` |
| GET | `/api/upload/{jobId}/events` | SSE progress stream |
| GET | `/api/doc/{id}` | document metadata |
| GET / HEAD | `/api/doc/{id}/pdf` | raw PDF bytes |
| GET / HEAD | `/api/doc/{id}/fonts/{filename}` | WOFF2 / TTF / OTF |
| GET / HEAD | `/api/doc/{id}/images/{filename}` | PNG / JPEG / GIF / WEBP |
| POST | `/api/doc/{id}/images` | upload image, ≤ 25 MB |
| POST | `/api/doc/{id}/save` | apply edits + insertions; returns `{document, warnings}` |
| POST | `/api/doc/{id}/pages` | add blank page |
| POST | `/api/doc/{id}/pages/reorder` | reorder pages |
| DELETE | `/api/doc/{id}/pages/{index}` | delete page |

## Stack

- **Frontend**: Vite, React 19, TypeScript, Tailwind, Zustand, pdfjs-dist 5, lucide-react
- **Backend**: FastAPI, uvicorn, PyMuPDF, fontTools, filelock, aiofiles, pydantic 2

## Smoke test

```bash
# Generate a 5-page blank PDF
cd api && .venv/bin/python -c "
import pymupdf
doc = pymupdf.open()
for _ in range(5):
    doc.new_page(width=612, height=792)
doc.save('/tmp/t.pdf')
"

# Upload through the Vite proxy
curl -X POST -F "file=@/tmp/t.pdf" http://localhost:5173/api/upload
```

## Known limitations

See [KNOWN_LIMITATIONS.md](./KNOWN_LIMITATIONS.md) for an honest list of what works, what's partial, and what's deferred.

## License

GNU AGPL-3.0-or-later — see [LICENSE](./LICENSE).

The copyleft is required by PyMuPDF (AGPL-3.0). The bundled fontlib also includes URW Base 35 (AGPL-3.0 + font-embedding exception); Liberation and Inter are SIL OFL 1.1. See `LICENSE` for the full notices.
