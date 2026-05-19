import * as pdfjsLib from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.mjs?url";

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

// Standard fonts + CMaps are required for non-embedded fonts
// (Helvetica/Times/Courier) and CJK PDFs. pdfjs-dist v5 does NOT auto-discover
// these — they must be passed to getDocument with trailing-slash URLs.
//
// The assets ship in `pdfjs-dist/cmaps/` and `pdfjs-dist/standard_fonts/`.
// Vite's `new URL(..., import.meta.url)` cannot bundle an entire directory,
// and `import.meta.glob` produces individually-hashed URLs that break pdfjs's
// `${cMapUrl}${name}.bcmap` concatenation. The reliable Vite pattern is to
// copy the directories into `web/public/` and reference them by absolute path
// — Vite serves `public/` as-is in dev and copies it into `dist/` on build.
//
// The copies live at `web/public/pdfjs/cmaps/` and
// `web/public/pdfjs/standard_fonts/`. Use a base-aware URL so this works under
// a non-root deployment base.
export const cMapUrl = `${import.meta.env.BASE_URL}pdfjs/cmaps/`;
export const standardFontDataUrl = `${import.meta.env.BASE_URL}pdfjs/standard_fonts/`;
export const cMapPacked = true;

export { pdfjsLib };
export type PDFDocumentProxy = Awaited<
  ReturnType<typeof pdfjsLib.getDocument>["promise"]
>;
export type PDFPageProxy = Awaited<ReturnType<PDFDocumentProxy["getPage"]>>;
