import { useCallback, useRef } from "react";
import type { LineInsertion, PageData } from "../lib/api";
import { pdfPointToCss } from "../lib/coords";
import { clampPointToPage, rgbToCssTriple } from "../lib/insertions";
import { useDocumentStore } from "../state/useDocumentStore";

type Props = {
  insertion: LineInsertion;
  cssScale: number;
  page: PageData;
  isActive: boolean;
};

const HANDLE_SIZE = 10;
const HIT_STROKE_PX = 12;

type DragKind = "move" | "from" | "to";
type DragState = {
  kind: DragKind;
  startX: number;
  startY: number;
  startFrom: [number, number];
  startTo: [number, number];
};

export function InsertionLine({ insertion, cssScale, page, isActive }: Props) {
  const setActiveInsertionId = useDocumentStore((s) => s.setActiveInsertionId);
  const updateInsertion = useDocumentStore((s) => s.updateInsertion);
  const dragRef = useRef<DragState | null>(null);

  const fromCss = pdfPointToCss(insertion.fromPt, cssScale);
  const toCss = pdfPointToCss(insertion.toPt, cssScale);
  const minX = Math.min(fromCss.left, toCss.left);
  const minY = Math.min(fromCss.top, toCss.top);
  const maxX = Math.max(fromCss.left, toCss.left);
  const maxY = Math.max(fromCss.top, toCss.top);

  const padding = Math.max(HANDLE_SIZE, HIT_STROKE_PX) + 4;
  const left = minX - padding;
  const top = minY - padding;
  const width = maxX - minX + 2 * padding;
  const height = maxY - minY + 2 * padding;

  const x1 = fromCss.left - left;
  const y1 = fromCss.top - top;
  const x2 = toCss.left - left;
  const y2 = toCss.top - top;

  const strokeCss = rgbToCssTriple(insertion.strokeRgb);
  const strokePx = insertion.strokeWidth * cssScale;

  const onLinePointerDown = useCallback(
    (e: React.PointerEvent<SVGElement>) => {
      e.preventDefault();
      e.stopPropagation();
      if (!isActive) {
        setActiveInsertionId(insertion.id);
        return;
      }
      dragRef.current = {
        kind: "move",
        startX: e.clientX,
        startY: e.clientY,
        startFrom: [insertion.fromPt[0], insertion.fromPt[1]],
        startTo: [insertion.toPt[0], insertion.toPt[1]],
      };
      (e.currentTarget as SVGElement).setPointerCapture(e.pointerId);
    },
    [isActive, insertion.id, insertion.fromPt, insertion.toPt, setActiveInsertionId],
  );

  const onHandlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>, kind: "from" | "to") => {
      e.preventDefault();
      e.stopPropagation();
      dragRef.current = {
        kind,
        startX: e.clientX,
        startY: e.clientY,
        startFrom: [insertion.fromPt[0], insertion.fromPt[1]],
        startTo: [insertion.toPt[0], insertion.toPt[1]],
      };
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    },
    [insertion.fromPt, insertion.toPt],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<Element>) => {
      const drag = dragRef.current;
      if (!drag) return;
      e.preventDefault();
      e.stopPropagation();
      const dxPt = (e.clientX - drag.startX) / cssScale;
      const dyPt = (e.clientY - drag.startY) / cssScale;
      if (drag.kind === "move") {
        const nextFrom = clampPointToPage(
          [drag.startFrom[0] + dxPt, drag.startFrom[1] + dyPt],
          page,
        );
        const nextTo = clampPointToPage(
          [drag.startTo[0] + dxPt, drag.startTo[1] + dyPt],
          page,
        );
        updateInsertion(insertion.id, { fromPt: nextFrom, toPt: nextTo });
      } else if (drag.kind === "from") {
        const nextFrom = clampPointToPage(
          [drag.startFrom[0] + dxPt, drag.startFrom[1] + dyPt],
          page,
        );
        updateInsertion(insertion.id, { fromPt: nextFrom });
      } else {
        const nextTo = clampPointToPage(
          [drag.startTo[0] + dxPt, drag.startTo[1] + dyPt],
          page,
        );
        updateInsertion(insertion.id, { toPt: nextTo });
      }
    },
    [cssScale, page, insertion.id, updateInsertion],
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent<Element>) => {
      if (!dragRef.current) return;
      e.preventDefault();
      e.stopPropagation();
      (e.currentTarget as Element).releasePointerCapture(e.pointerId);
      dragRef.current = null;
    },
    [],
  );

  const arrowHead = (() => {
    if (insertion.type !== "arrow") return null;
    const headLen = Math.max(8, strokePx * 4);
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy);
    if (len === 0) return null;
    const ux = dx / len;
    const uy = dy / len;
    const px = -uy;
    const py = ux;
    const baseX = x2 - ux * headLen;
    const baseY = y2 - uy * headLen;
    const halfW = headLen * 0.45;
    const p1 = `${baseX + px * halfW},${baseY + py * halfW}`;
    const p2 = `${x2},${y2}`;
    const p3 = `${baseX - px * halfW},${baseY - py * halfW}`;
    return (
      <polygon
        points={`${p1} ${p2} ${p3}`}
        fill={strokeCss}
        stroke="none"
        style={{ pointerEvents: "none" }}
      />
    );
  })();

  const wrapperStyle: React.CSSProperties = {
    position: "absolute",
    left: `${left}px`,
    top: `${top}px`,
    width: `${width}px`,
    height: `${height}px`,
    cursor: isActive ? "move" : "pointer",
  };

  const adjustedToX = (() => {
    if (insertion.type !== "arrow") return x2;
    const headLen = Math.max(8, strokePx * 4);
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy);
    if (len === 0) return x2;
    return x2 - (dx / len) * headLen * 0.6;
  })();
  const adjustedToY = (() => {
    if (insertion.type !== "arrow") return y2;
    const headLen = Math.max(8, strokePx * 4);
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy);
    if (len === 0) return y2;
    return y2 - (dy / len) * headLen * 0.6;
  })();

  return (
    <div
      data-insertion-id={insertion.id}
      style={wrapperStyle}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <svg
        width={width}
        height={height}
        style={{ position: "absolute", inset: 0, overflow: "visible" }}
      >
        <line
          x1={x1}
          y1={y1}
          x2={x2}
          y2={y2}
          stroke="transparent"
          strokeWidth={HIT_STROKE_PX}
          style={{ pointerEvents: "stroke", cursor: isActive ? "move" : "pointer" }}
          onPointerDown={onLinePointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        />
        <line
          x1={x1}
          y1={y1}
          x2={adjustedToX}
          y2={adjustedToY}
          stroke={strokeCss}
          strokeWidth={strokePx}
          strokeLinecap="round"
          style={{ pointerEvents: "none" }}
        />
        {arrowHead}
        {isActive ? (
          <rect
            x={Math.min(x1, x2) - 4}
            y={Math.min(y1, y2) - 4}
            width={Math.abs(x2 - x1) + 8}
            height={Math.abs(y2 - y1) + 8}
            fill="none"
            stroke="#4a90e2"
            strokeWidth={1}
            strokeDasharray="3 3"
            style={{ pointerEvents: "none" }}
          />
        ) : null}
      </svg>
      {isActive ? (
        <>
          <Endpoint
            cssX={x1}
            cssY={y1}
            onPointerDown={(e) => onHandlePointerDown(e, "from")}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
          />
          <Endpoint
            cssX={x2}
            cssY={y2}
            onPointerDown={(e) => onHandlePointerDown(e, "to")}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
          />
        </>
      ) : null}
    </div>
  );
}

function Endpoint({
  cssX,
  cssY,
  onPointerDown,
  onPointerMove,
  onPointerUp,
}: {
  cssX: number;
  cssY: number;
  onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void;
  onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => void;
  onPointerUp: (e: React.PointerEvent<HTMLDivElement>) => void;
}) {
  return (
    <div
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      style={{
        position: "absolute",
        left: cssX - HANDLE_SIZE / 2,
        top: cssY - HANDLE_SIZE / 2,
        width: HANDLE_SIZE,
        height: HANDLE_SIZE,
        background: "white",
        border: "1px solid #4a90e2",
        borderRadius: "50%",
        cursor: "crosshair",
        zIndex: 21,
      }}
    />
  );
}
