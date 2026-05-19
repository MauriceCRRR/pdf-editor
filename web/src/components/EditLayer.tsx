import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Insertion, PageData } from "../lib/api";
import { uploadImage } from "../lib/api";
import { clearCanvasRegion } from "../lib/canvas-clear";
import { pdfBboxToCssRect, pdfPointToCss } from "../lib/coords";
import { getEffectiveStyle } from "../lib/edits";
import { fontFamilyForSpan } from "../lib/fonts";
import {
  buildBoxFromDrag,
  buildLineFromDrag,
  clampPointToPage,
  makeImageInsertion,
  makeLineInsertion,
  makeShapeInsertion,
  makeTextInsertion,
} from "../lib/insertions";
import { useDocumentStore, type EditMode } from "../state/useDocumentStore";
import { FragBox } from "./FragBox";
import { InsertionImage } from "./InsertionImage";
import { InsertionLine } from "./InsertionLine";
import { InsertionShape } from "./InsertionShape";
import { InsertionTextBox } from "./InsertionTextBox";
import { MissingGlyphWarning } from "./MissingGlyphWarning";

type Props = {
  pageData: PageData;
  cssScale: number;
  dpr: number;
  editMode: EditMode;
};

type PendingDrag = {
  pointerId: number;
  startPt: [number, number];
  currentPt: [number, number];
  tool: "text" | "rectangle" | "ellipse" | "line" | "arrow";
};

type PendingImageUpload = {
  startPt: [number, number];
  endPt: [number, number] | null;
};

export function EditLayer({ pageData, cssScale, dpr, editMode }: Props) {
  const activeFragId = useDocumentStore((s) => s.activeFragId);
  const setActiveFragId = useDocumentStore((s) => s.setActiveFragId);
  const fontByRef = useDocumentStore((s) => s.fontByRef);
  const subsetByRef = useDocumentStore((s) => s.subsetByRef);
  const masterByRef = useDocumentStore((s) => s.masterByRef);
  const expandedFragments = useDocumentStore((s) => s.expandedFragments);
  const pageCanvases = useDocumentStore((s) => s.pageCanvases);
  const edits = useDocumentStore((s) => s.edits);
  const insertions = useDocumentStore((s) => s.insertions);
  const insertMode = useDocumentStore((s) => s.insertMode);
  const activeInsertionId = useDocumentStore((s) => s.activeInsertionId);
  const createInsertion = useDocumentStore((s) => s.createInsertion);
  const setActiveInsertionId = useDocumentStore((s) => s.setActiveInsertionId);
  const documentId = useDocumentStore((s) => s.document?.documentId ?? null);
  const renderVersion = useDocumentStore(
    (s) => s.renderVersions.get(pageData.index) ?? 0,
  );
  const layerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState<PendingDrag | null>(null);
  const pendingImageRef = useRef<PendingImageUpload | null>(null);
  const capturedPointerIdRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      const pointerId = capturedPointerIdRef.current;
      const layer = layerRef.current;
      if (pointerId !== null && layer && layer.hasPointerCapture?.(pointerId)) {
        layer.releasePointerCapture(pointerId);
      }
      capturedPointerIdRef.current = null;
    };
  }, []);

  const fragmentRenderData = useMemo(
    () =>
      pageData.fragments.map((frag) => {
        const edit = edits.get(frag.id);
        const effective = getEffectiveStyle(frag, edit);
        const rect = pdfBboxToCssRect(effective.newBBox, cssScale);
        const originalRect = pdfBboxToCssRect(effective.originalBBox, cssScale);
        return { frag, edit, rect, originalRect };
      }),
    [pageData.fragments, cssScale, edits],
  );

  const isInsertActive = editMode === "insert" && insertMode !== null;
  const interactive = editMode === "edit-text" || isInsertActive;
  const insertTool = insertMode?.tool ?? null;

  const clearedRects = useMemo(() => {
    // Only clear the canvas for fragments with persistent edits. clearCanvasRegion
    // is destructive — clearing for transient activeFragId leaves white holes when
    // the user clicks a fragment and clicks away without editing. The active
    // FragBox covers the original with its own white background instead.
    const list: { left: number; top: number; width: number; height: number }[] = [];
    for (const { edit, originalRect } of fragmentRenderData) {
      if (edit !== undefined) {
        list.push(originalRect);
      }
    }
    return list;
  }, [fragmentRenderData]);

  useEffect(() => {
    if (clearedRects.length === 0) return;
    const canvas = pageCanvases.get(pageData.index);
    if (!canvas) return;
    for (const rect of clearedRects) {
      clearCanvasRegion(canvas, rect, dpr);
    }
  }, [clearedRects, pageCanvases, pageData.index, dpr, renderVersion]);

  const pageInsertions = useMemo<Insertion[]>(
    () => [...insertions.values()].filter((i) => i.pageIndex === pageData.index),
    [insertions, pageData.index],
  );

  const pointFromEvent = useCallback(
    (e: React.PointerEvent<HTMLDivElement>): [number, number] => {
      const layer = layerRef.current;
      if (!layer) return [0, 0];
      const r = layer.getBoundingClientRect();
      const cssX = e.clientX - r.left;
      const cssY = e.clientY - r.top;
      const pt: [number, number] = [cssX / cssScale, cssY / cssScale];
      return clampPointToPage(pt, pageData);
    },
    [cssScale, pageData],
  );

  const onLayerPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!isInsertActive || !insertTool) return;
      if (e.target !== e.currentTarget) return;
      e.preventDefault();
      setActiveInsertionId(null);
      const startPt = pointFromEvent(e);

      if (insertTool === "image") {
        pendingImageRef.current = { startPt, endPt: null };
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        capturedPointerIdRef.current = e.pointerId;
        setDrag({
          pointerId: e.pointerId,
          startPt,
          currentPt: startPt,
          tool: "rectangle",
        });
        return;
      }

      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      capturedPointerIdRef.current = e.pointerId;
      setDrag({
        pointerId: e.pointerId,
        startPt,
        currentPt: startPt,
        tool: insertTool,
      });
    },
    [isInsertActive, insertTool, pointFromEvent, setActiveInsertionId],
  );

  const onLayerPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!drag) return;
      if (e.pointerId !== drag.pointerId) return;
      e.preventDefault();
      const currentPt = pointFromEvent(e);
      setDrag({ ...drag, currentPt });
      if (pendingImageRef.current) {
        pendingImageRef.current.endPt = currentPt;
      }
    },
    [drag, pointFromEvent],
  );

  const finishDrag = useCallback(
    (endPt: [number, number]) => {
      if (!drag) return;
      const dragInfo = { start: drag.startPt, end: endPt };

      if (drag.tool === "text") {
        const bbox = buildBoxFromDrag(dragInfo, pageData);
        const ins = makeTextInsertion(pageData.index, bbox);
        createInsertion(ins);
      } else if (drag.tool === "rectangle" || drag.tool === "ellipse") {
        const bbox = buildBoxFromDrag(dragInfo, pageData);
        const ins = makeShapeInsertion(drag.tool, pageData.index, bbox);
        createInsertion(ins);
      } else if (drag.tool === "line" || drag.tool === "arrow") {
        const { from, to } = buildLineFromDrag(dragInfo, pageData);
        const ins = makeLineInsertion(drag.tool, pageData.index, from, to);
        createInsertion(ins);
      }
    },
    [drag, pageData, createInsertion],
  );

  const onLayerPointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!drag) return;
      if (e.pointerId !== drag.pointerId) return;
      e.preventDefault();
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
      capturedPointerIdRef.current = null;
      const endPt = pointFromEvent(e);

      if (pendingImageRef.current) {
        pendingImageRef.current.endPt = endPt;
        setDrag(null);
        fileInputRef.current?.click();
        return;
      }

      finishDrag(endPt);
      setDrag(null);
    },
    [drag, pointFromEvent, finishDrag],
  );

  const onLayerPointerCancel = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!drag) return;
      if (e.pointerId !== drag.pointerId) return;
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
      capturedPointerIdRef.current = null;
      pendingImageRef.current = null;
      setDrag(null);
    },
    [drag],
  );

  const onFileSelected = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      const pending = pendingImageRef.current;
      pendingImageRef.current = null;
      e.target.value = "";
      if (!file || !pending || !documentId) return;
      try {
        const uploaded = await uploadImage(documentId, file);
        const aspect = uploaded.heightPx === 0 ? 1 : uploaded.widthPx / uploaded.heightPx;
        const start = pending.startPt;
        const end = pending.endPt ?? pending.startPt;
        const dragW = Math.abs(end[0] - start[0]);
        const dragH = Math.abs(end[1] - start[1]);
        let bbox: [number, number, number, number];
        if (dragW < 5 || dragH < 5) {
          const w = aspect >= 1 ? 200 : 200 * aspect;
          const h = aspect >= 1 ? 200 / aspect : 200;
          bbox = [start[0], start[1], start[0] + w, start[1] + h];
        } else {
          const x0 = Math.min(start[0], end[0]);
          const y0 = Math.min(start[1], end[1]);
          bbox = [x0, y0, x0 + dragW, y0 + dragH];
        }
        bbox = [
          Math.max(0, bbox[0]),
          Math.max(0, bbox[1]),
          Math.min(pageData.widthPt, bbox[2]),
          Math.min(pageData.heightPt, bbox[3]),
        ];
        const ins = makeImageInsertion(pageData.index, bbox, uploaded.imageRef);
        createInsertion(ins);
      } catch (err) {
        console.error("[image upload] failed:", err);
      }
    },
    [documentId, pageData.index, pageData.widthPt, pageData.heightPt, createInsertion],
  );

  const onLayerBackgroundClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (e.target !== e.currentTarget) return;
      if (activeInsertionId !== null) {
        setActiveInsertionId(null);
      }
      if (activeFragId !== null) {
        setActiveFragId(null);
      }
    },
    [activeInsertionId, activeFragId, setActiveInsertionId, setActiveFragId],
  );

  const previewElement = (() => {
    if (!drag) return null;
    if (drag.tool === "line" || drag.tool === "arrow") {
      const a = pdfPointToCss(drag.startPt, cssScale);
      const b = pdfPointToCss(drag.currentPt, cssScale);
      return (
        <svg
          width="100%"
          height="100%"
          style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
        >
          <line
            x1={a.left}
            y1={a.top}
            x2={b.left}
            y2={b.top}
            stroke="#4a90e2"
            strokeWidth={1.5}
            strokeDasharray="4 4"
          />
        </svg>
      );
    }
    const sCss = pdfPointToCss(drag.startPt, cssScale);
    const cCss = pdfPointToCss(drag.currentPt, cssScale);
    const left = Math.min(sCss.left, cCss.left);
    const top = Math.min(sCss.top, cCss.top);
    const width = Math.abs(cCss.left - sCss.left);
    const height = Math.abs(cCss.top - sCss.top);
    return (
      <div
        style={{
          position: "absolute",
          left,
          top,
          width,
          height,
          border: "1px dashed #4a90e2",
          background: "rgba(74, 144, 226, 0.08)",
          pointerEvents: "none",
        }}
      />
    );
  })();

  const cursor = isInsertActive ? "crosshair" : "auto";

  return (
    <div
      ref={layerRef}
      className={[
        "absolute inset-0",
        interactive ? "pointer-events-auto" : "pointer-events-none",
      ].join(" ")}
      style={{ cursor }}
      onPointerDown={isInsertActive ? onLayerPointerDown : undefined}
      onPointerMove={isInsertActive ? onLayerPointerMove : undefined}
      onPointerUp={isInsertActive ? onLayerPointerUp : undefined}
      onPointerCancel={isInsertActive ? onLayerPointerCancel : undefined}
      onClick={onLayerBackgroundClick}
    >
      {fragmentRenderData.map(({ frag, edit, rect }) => {
        const firstSpan = frag.spans[0];
        const useMaster = expandedFragments.has(frag.id);
        const fontFamily = firstSpan
          ? fontFamilyForSpan(firstSpan, fontByRef, subsetByRef, masterByRef, useMaster)
          : "ui-sans-serif, system-ui, sans-serif";
        const isActive = frag.id === activeFragId;
        const fontEntry = firstSpan?.fontRef ? fontByRef.get(firstSpan.fontRef) ?? null : null;
        const showWarning =
          isActive &&
          useMaster &&
          fontEntry !== null &&
          fontEntry.masterUrl === null;
        return (
          <div key={frag.id}>
            <FragBox
              fragment={frag}
              rect={rect}
              interactive={editMode === "edit-text"}
              isActive={isActive}
              edit={edit}
              onActivate={() => setActiveFragId(frag.id)}
              onDeactivate={() => setActiveFragId(null)}
              fontFamily={fontFamily}
              cssScale={cssScale}
              page={pageData}
            />
            {showWarning && fontEntry ? (
              <MissingGlyphWarning rect={rect} fallbackFamily={fontEntry.fallbackFamily} />
            ) : null}
          </div>
        );
      })}
      {pageInsertions.map((ins) => {
        const isActive = ins.id === activeInsertionId;
        if (ins.type === "text") {
          return (
            <InsertionTextBox
              key={ins.id}
              insertion={ins}
              cssScale={cssScale}
              page={pageData}
              isActive={isActive}
            />
          );
        }
        if (ins.type === "rectangle" || ins.type === "ellipse") {
          return (
            <InsertionShape
              key={ins.id}
              insertion={ins}
              cssScale={cssScale}
              page={pageData}
              isActive={isActive}
            />
          );
        }
        if (ins.type === "line" || ins.type === "arrow") {
          return (
            <InsertionLine
              key={ins.id}
              insertion={ins}
              cssScale={cssScale}
              page={pageData}
              isActive={isActive}
            />
          );
        }
        if (ins.type === "image" && documentId) {
          return (
            <InsertionImage
              key={ins.id}
              insertion={ins}
              cssScale={cssScale}
              page={pageData}
              isActive={isActive}
              documentId={documentId}
            />
          );
        }
        return null;
      })}
      {previewElement}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        hidden
        onChange={onFileSelected}
      />
    </div>
  );
}
