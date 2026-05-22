import { useCallback, useEffect, useRef } from "react";
import type { PageData, TextInsertion } from "../lib/api";
import { pdfBboxToCssRect } from "../lib/coords";
import { clampBoxToPage, rgbToCssTriple } from "../lib/insertions";
import { useDocumentStore } from "../state/useDocumentStore";
import { InsertionResizeHandles } from "./InsertionResizeHandles";

type Props = {
  insertion: TextInsertion;
  cssScale: number;
  page: PageData;
  isActive: boolean;
};

const EDGE_PX = 6;

type DragState = {
  startX: number;
  startY: number;
  startBBox: [number, number, number, number];
};

function textDecoration(underline: boolean, strikethrough: boolean): string {
  const parts: string[] = [];
  if (underline) parts.push("underline");
  if (strikethrough) parts.push("line-through");
  return parts.length === 0 ? "none" : parts.join(" ");
}

export function InsertionTextBox({ insertion, cssScale, page, isActive }: Props) {
  const editableRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const setActiveInsertionId = useDocumentStore((s) => s.setActiveInsertionId);
  const updateInsertion = useDocumentStore((s) => s.updateInsertion);

  const rect = pdfBboxToCssRect(insertion.bbox, cssScale);

  useEffect(() => {
    if (!isActive) return;
    const el = editableRef.current;
    if (!el) return;
    el.textContent = insertion.text;
    const id = window.setTimeout(() => {
      el.focus();
      const selection = window.getSelection();
      if (selection) {
        const range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
        selection.removeAllRanges();
        selection.addRange(range);
      }
    }, 0);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive]);

  useEffect(() => {
    if (!isActive) return;
    const el = editableRef.current;
    if (!el) return;
    if (document.activeElement === el) return;
    if (el.textContent !== insertion.text) {
      el.textContent = insertion.text;
    }
  }, [isActive, insertion.text]);

  const isOnEdge = useCallback(
    (e: React.PointerEvent<HTMLDivElement>): boolean => {
      const container = containerRef.current;
      if (!container) return false;
      const r = container.getBoundingClientRect();
      const x = e.clientX - r.left;
      const y = e.clientY - r.top;
      if (x < EDGE_PX || x > r.width - EDGE_PX) return true;
      if (y < EDGE_PX || y > r.height - EDGE_PX) return true;
      return false;
    },
    [],
  );

  const onDragPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!isActive) return;
      if (!isOnEdge(e)) return;
      e.preventDefault();
      e.stopPropagation();
      dragRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        startBBox: [insertion.bbox[0], insertion.bbox[1], insertion.bbox[2], insertion.bbox[3]],
      };
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    },
    [isActive, isOnEdge, insertion.bbox],
  );

  const onDragPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag) return;
      e.preventDefault();
      e.stopPropagation();
      const dxPt = (e.clientX - drag.startX) / cssScale;
      const dyPt = (e.clientY - drag.startY) / cssScale;
      const [x0, y0, x1, y1] = drag.startBBox;
      const next: [number, number, number, number] = [
        x0 + dxPt,
        y0 + dyPt,
        x1 + dxPt,
        y1 + dyPt,
      ];
      const clamped = clampBoxToPage(next, page);
      updateInsertion(insertion.id, { bbox: clamped });
    },
    [cssScale, page, insertion.id, updateInsertion],
  );

  const onDragPointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!dragRef.current) return;
      e.preventDefault();
      e.stopPropagation();
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
      dragRef.current = null;
    },
    [],
  );

  const borderClass = isActive
    ? "border border-solid border-[#4a90e2]"
    : "border border-dotted border-[#4a90e2] hover:border-solid";

  const baseClass = ["absolute box-border", borderClass, !isActive ? "cursor-text" : ""]
    .filter(Boolean)
    .join(" ");

  const baseStyle: React.CSSProperties = {
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
  };

  if (!isActive) {
    return (
      <div
        data-insertion-id={insertion.id}
        style={baseStyle}
        className={baseClass}
        onMouseDown={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setActiveInsertionId(insertion.id);
        }}
      >
        {insertion.text ? (
          <div
            style={{
              fontSize: `${insertion.size * cssScale}px`,
              color: rgbToCssTriple(insertion.colorRgb),
              fontWeight: insertion.bold ? 700 : 400,
              fontStyle: insertion.italic ? "italic" : "normal",
              textDecoration: textDecoration(insertion.underline, insertion.strikethrough),
              textAlign: insertion.align,
              lineHeight: 1,
              whiteSpace: "pre",
              width: "100%",
              height: "100%",
              padding: 0,
              margin: 0,
              overflow: "hidden",
              pointerEvents: "none",
            }}
          >
            {insertion.text}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      data-insertion-id={insertion.id}
      style={baseStyle}
      className={`${baseClass} group`}
      onPointerDown={onDragPointerDown}
      onPointerMove={onDragPointerMove}
      onPointerUp={onDragPointerUp}
      onPointerCancel={onDragPointerUp}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div
        ref={editableRef}
        contentEditable
        suppressContentEditableWarning
        dir="ltr"
        spellCheck={false}
        onInput={(e) => {
          const text = (e.currentTarget.textContent ?? "");
          updateInsertion(insertion.id, { text });
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            setActiveInsertionId(null);
          }
        }}
        onPointerDown={(e) => {
          if (!containerRef.current) return;
          const r = containerRef.current.getBoundingClientRect();
          const x = e.clientX - r.left;
          const y = e.clientY - r.top;
          const onEdge =
            x < EDGE_PX ||
            x > r.width - EDGE_PX ||
            y < EDGE_PX ||
            y > r.height - EDGE_PX;
          if (onEdge) {
            e.preventDefault();
          }
        }}
        style={{
          fontSize: `${insertion.size * cssScale}px`,
          color: rgbToCssTriple(insertion.colorRgb),
          fontWeight: insertion.bold ? 700 : 400,
          fontStyle: insertion.italic ? "italic" : "normal",
          textDecoration: textDecoration(insertion.underline, insertion.strikethrough),
          textAlign: insertion.align,
          lineHeight: 1,
          whiteSpace: "pre",
          width: "100%",
          height: "100%",
          outline: "none",
          userSelect: "text",
          padding: 0,
          margin: 0,
          display: "block",
          overflow: "hidden",
          cursor: "text",
        }}
      />
      <div className="opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto">
        <InsertionResizeHandles
          insertionId={insertion.id}
          bbox={insertion.bbox}
          cssScale={cssScale}
          page={page}
        />
      </div>
    </div>
  );
}
