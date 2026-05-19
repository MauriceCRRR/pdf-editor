# PDF Editor — Web

Vite + React + TypeScript frontend for the PDF editor.

## Develop

```bash
npm install
npm run dev
```

Dev server runs at http://localhost:5173 and proxies `/api/*` to
`http://localhost:8000` (the FastAPI backend).

## Stack

- Vite 5+
- React 18+ / TypeScript (strict)
- pdfjs-dist ^5
- Tailwind CSS 3
- Zustand
