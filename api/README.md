# PDF Editor API

FastAPI backend for the PDF editor — Milestone 1 (file storage + serving only).

## Requirements

- Python 3.12+
- macOS, Linux, or WSL

## Setup

```bash
cd api
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## Run

```bash
./run.sh
# or
uvicorn app.main:app --reload --port 8000
```

The server listens on http://localhost:8000.

CORS is configured for the Vite dev server at http://localhost:5173.

## Endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/api/health` | Health probe. |
| POST | `/api/upload` | Multipart `file` (PDF). Returns `{documentId, pageCount, filename}`. |
| GET | `/api/doc/{documentId}` | Returns document metadata. |
| GET | `/api/doc/{documentId}/pdf` | Returns the raw PDF bytes. |

## Storage layout

PDFs and metadata are stored on the local filesystem at `../storage/{documentId}/`:

```
storage/
  <uuid>/
    original.pdf
    meta.json
```

`meta.json` contains `filename`, `uploadedAt` (ISO 8601 UTC), `sizeBytes`, and `pageCount`.

## Constraints

- Max upload size: 50 MB.
- Only `application/pdf` (or `.pdf` extension) is accepted.
- Files are streamed to disk in 1 MB chunks; the request body is never buffered fully in memory.

## Smoke test

```bash
curl http://localhost:8000/api/health
# {"status":"ok"}

python -c "from pypdf import PdfWriter; w = PdfWriter(); w.add_blank_page(width=612, height=792); w.write('/tmp/test.pdf')"
curl -X POST -F "file=@/tmp/test.pdf" http://localhost:8000/api/upload
# {"documentId":"<uuid>","pageCount":1,"filename":"test.pdf"}
```
