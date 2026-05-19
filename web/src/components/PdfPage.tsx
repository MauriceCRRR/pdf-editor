import { useEffect, useRef, useState } from "react";
import type { PageData } from "../lib/api";
import type { RenderTask } from "pdfjs-dist";
import type { PDFDocumentProxy } from "../lib/pdfjs";
import { useDocumentStore } from "../state/useDocumentStore";
import { EditLayer } from "./EditLayer";

type Props = {
  pdf: PDFDocumentProxy;
  pageNumber: number;
  pageData?: PageData;
  scale?: number;
  thumbnail?: boolean;
};

export function PdfPage({
  pdf,
  pageNumber,
  pageData,
  scale = 1.25,
  thumbnail = false,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const prevTaskRef = useRef<RenderTask | null>(null);
  const [dims, setDims] = useState<{ width: number; height: number } | null>(null);
  const [cssScale, setCssScale] = useState<number | null>(null);
  const [dpr, setDpr] = useState<number>(1);
  const editMode = useDocumentStore((s) => s.editMode);
  const registerCanvas = useDocumentStore((s) => s.registerCanvas);
  const unregisterCanvas = useDocumentStore((s) => s.unregisterCanvas);
  const bumpRenderVersion = useDocumentStore((s) => s.bumpRenderVersion);

  useEffect(() => {
    let cancelled = false;
    let renderTask: RenderTask | null = null;

    (async () => {
      // Drain any in-flight render on the same canvas before starting a new
      // one. pdfjs v5 throws "Cannot use the same canvas during multiple
      // render operations" if a new render begins before the previous one
      // unwinds, which happens on rapid scale changes since cancel() resolves
      // asynchronously.
      if (prevTaskRef.current) {
        prevTaskRef.current.cancel();
        try {
          await prevTaskRef.current.promise;
        } catch {
          // expected: RenderingCancelledException
        }
      }
      if (cancelled) return;

      const page = await pdf.getPage(pageNumber);
      if (cancelled) return;

      const currentDpr = thumbnail ? 1 : window.devicePixelRatio || 1;
      const viewport = page.getViewport({ scale: scale * currentDpr });
      const canvas = canvasRef.current;
      if (!canvas) return;

      // Make the backing store and CSS box agree at fractional DPRs. Round
      // the backing store to an integer device-pixel size first, then derive
      // the CSS size from it so they don't drift by up to 1 device pixel.
      const backingWidth = Math.round(viewport.width);
      const backingHeight = Math.round(viewport.height);
      canvas.width = backingWidth;
      canvas.height = backingHeight;
      const cssWidth = backingWidth / currentDpr;
      const cssHeight = backingHeight / currentDpr;
      canvas.style.width = `${cssWidth}px`;
      canvas.style.height = `${cssHeight}px`;
      setDims({ width: cssWidth, height: cssHeight });
      setCssScale(viewport.scale / currentDpr);
      setDpr(currentDpr);

      renderTask = page.render({ canvas, viewport });
      prevTaskRef.current = renderTask;
      try {
        await renderTask.promise;
        if (!cancelled && !thumbnail && pageData) {
          bumpRenderVersion(pageData.index);
        }
      } catch (err) {
        const name = (err as { name?: string }).name;
        if (name !== "RenderingCancelledException") {
          throw err;
        }
      } finally {
        if (prevTaskRef.current === renderTask) {
          prevTaskRef.current = null;
        }
      }
    })().catch(() => {});

    return () => {
      cancelled = true;
      if (renderTask) {
        renderTask.cancel();
      }
    };
  }, [pdf, pageNumber, scale, thumbnail, pageData, bumpRenderVersion]);

  useEffect(() => {
    if (thumbnail || !pageData) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const index = pageData.index;
    registerCanvas(index, canvas);
    return () => {
      unregisterCanvas(index);
    };
  }, [pageData, thumbnail, registerCanvas, unregisterCanvas]);

  if (thumbnail) {
    return (
      <canvas
        ref={canvasRef}
        style={dims ? { width: `${dims.width}px`, height: `${dims.height}px` } : undefined}
        className="block"
      />
    );
  }

  return (
    <div
      className="relative block bg-white shadow-sm"
      style={dims ? { width: `${dims.width}px`, height: `${dims.height}px` } : undefined}
    >
      <canvas
        ref={canvasRef}
        style={dims ? { width: `${dims.width}px`, height: `${dims.height}px` } : undefined}
        className="block"
      />
      {pageData?.appearsScanned ? (
        <div className="absolute top-2 left-2 right-2 z-20 bg-yellow-50 border border-yellow-300 rounded px-3 py-2 text-xs text-yellow-900 shadow-sm">
          <strong>Scanned page detected.</strong> This page appears to be a scanned image with an invisible OCR text layer. Text edits won&apos;t change the visible image &mdash; use Insert mode to overlay new text instead.
        </div>
      ) : null}
      {pageData && cssScale !== null ? (
        <EditLayer
          pageData={pageData}
          cssScale={cssScale}
          dpr={dpr}
          editMode={editMode}
        />
      ) : null}
    </div>
  );
}
