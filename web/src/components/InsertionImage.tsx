import { useCallback, useRef } from "react";
import type { ImageInsertion, PageData } from "../lib/api";
import { getImageUrl } from "../lib/api";
import { pdfBboxToCssRect } from "../lib/coords";
import { clampBoxToPage } from "../lib/insertions";
import { useDocumentStore } from "../state/useDocumentStore";
import { InsertionResizeHandles } from "./InsertionResizeHandles";

type Props = {
  insertion: ImageInsertion;
  cssScale: number;
  page: PageData;
  isActive: boolean;
  documentId: string;
};

type DragState = {
  startX: number;
  startY: number;
  startBBox: [number, number, number, number];
};

export function InsertionImage({ insertion, cssScale, page, isActive, documentId }: Props) {
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

  const url = getImageUrl(documentId, insertion.imageRef);

  return (
    <div
      data-insertion-id={insertion.id}
      className={["absolute box-border overflow-hidden group", borderClass].join(" ")}
      style={{
        left: `${rect.left}px`,
        top: `${rect.top}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
        cursor: isActive ? "move" : "pointer",
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <img
        src={url}
        alt=""
        draggable={false}
        style={{
          width: "100%",
          height: "100%",
          objectFit: "fill",
          pointerEvents: "none",
          userSelect: "none",
          display: "block",
        }}
      />
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
