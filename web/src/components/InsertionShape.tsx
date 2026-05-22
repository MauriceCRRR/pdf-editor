import { useCallback, useRef } from "react";
import type { PageData, ShapeInsertion } from "../lib/api";
import { pdfBboxToCssRect } from "../lib/coords";
import { clampBoxToPage, rgbToCssTriple } from "../lib/insertions";
import { useDocumentStore } from "../state/useDocumentStore";
import { InsertionResizeHandles } from "./InsertionResizeHandles";

type Props = {
  insertion: ShapeInsertion;
  cssScale: number;
  page: PageData;
  isActive: boolean;
};

type DragState = {
  startX: number;
  startY: number;
  startBBox: [number, number, number, number];
};

export function InsertionShape({ insertion, cssScale, page, isActive }: Props) {
  const setActiveInsertionId = useDocumentStore((s) => s.setActiveInsertionId);
  const updateInsertion = useDocumentStore((s) => s.updateInsertion);
  const dragRef = useRef<DragState | null>(null);

  const rect = pdfBboxToCssRect(insertion.bbox, cssScale);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      if (!isActive) {
        setActiveInsertionId(insertion.id);
        return;
      }
      dragRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        startBBox: [insertion.bbox[0], insertion.bbox[1], insertion.bbox[2], insertion.bbox[3]],
      };
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    },
    [isActive, insertion.id, insertion.bbox, setActiveInsertionId],
  );

  const onPointerMove = useCallback(
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

  const onPointerUp = useCallback(
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

  const wrapperStyle: React.CSSProperties = {
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    cursor: isActive ? "move" : "pointer",
  };

  const strokeCss = insertion.strokeRgb ? rgbToCssTriple(insertion.strokeRgb) : "none";
  const fillCss = insertion.fillRgb ? rgbToCssTriple(insertion.fillRgb) : "none";
  const strokePx = insertion.strokeWidth * cssScale;

  return (
    <div
      data-insertion-id={insertion.id}
      className={["absolute box-border group", borderClass].join(" ")}
      style={wrapperStyle}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <svg
        width={rect.width}
        height={rect.height}
        viewBox={`0 0 ${rect.width} ${rect.height}`}
        style={{ position: "absolute", inset: 0, pointerEvents: "none", overflow: "visible" }}
      >
        {insertion.type === "rectangle" ? (
          <rect
            x={strokePx / 2}
            y={strokePx / 2}
            width={Math.max(0, rect.width - strokePx)}
            height={Math.max(0, rect.height - strokePx)}
            stroke={strokeCss}
            fill={fillCss}
            strokeWidth={strokePx}
          />
        ) : (
          <ellipse
            cx={rect.width / 2}
            cy={rect.height / 2}
            rx={Math.max(0, rect.width / 2 - strokePx / 2)}
            ry={Math.max(0, rect.height / 2 - strokePx / 2)}
            stroke={strokeCss}
            fill={fillCss}
            strokeWidth={strokePx}
          />
        )}
      </svg>
      {isActive ? (
        <div className="opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto">
          <InsertionResizeHandles
            insertionId={insertion.id}
            bbox={insertion.bbox}
            cssScale={cssScale}
            page={page}
          />
        </div>
      ) : null}
    </div>
  );
}
