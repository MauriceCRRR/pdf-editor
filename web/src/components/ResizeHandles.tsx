import { useCallback, useRef } from "react";
import type { PageData } from "../lib/api";
import { useDocumentStore } from "../state/useDocumentStore";

type HandleId = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

type HandleDef = {
  id: HandleId;
  cursor: string;
  style: React.CSSProperties;
};

const HANDLE_SIZE = 8;
const MIN_WIDTH_PT = 10;
const MIN_HEIGHT_PT = 4;

// Handles sit fully outside the bbox so they don't cover glyph strokes on
// short fragments (e.g. 13 px tall lines), which made the text look fragmented
// and "less bold" than the underlying rasterized PDF.
const OFFSET = HANDLE_SIZE;

const HANDLES: HandleDef[] = [
  { id: "nw", cursor: "nwse-resize", style: { left: -OFFSET, top: -OFFSET } },
  { id: "n", cursor: "ns-resize", style: { left: "50%", top: -OFFSET, transform: "translateX(-50%)" } },
  { id: "ne", cursor: "nesw-resize", style: { right: -OFFSET, top: -OFFSET } },
  { id: "e", cursor: "ew-resize", style: { right: -OFFSET, top: "50%", transform: "translateY(-50%)" } },
  { id: "se", cursor: "nwse-resize", style: { right: -OFFSET, bottom: -OFFSET } },
  { id: "s", cursor: "ns-resize", style: { left: "50%", bottom: -OFFSET, transform: "translateX(-50%)" } },
  { id: "sw", cursor: "nesw-resize", style: { left: -OFFSET, bottom: -OFFSET } },
  { id: "w", cursor: "ew-resize", style: { left: -OFFSET, top: "50%", transform: "translateY(-50%)" } },
];

type DragState = {
  startX: number;
  startY: number;
  startBBox: [number, number, number, number];
  handle: HandleId;
};

type Props = {
  fragId: string;
  bbox: [number, number, number, number];
  cssScale: number;
  page: PageData;
};

function clampBBox(
  next: [number, number, number, number],
  page: PageData,
): [number, number, number, number] {
  const minW = MIN_WIDTH_PT;
  const minH = MIN_HEIGHT_PT;
  let [x0, y0, x1, y1] = next;
  if (x1 - x0 < minW) {
    const mid = (x0 + x1) / 2;
    x0 = mid - minW / 2;
    x1 = mid + minW / 2;
  }
  if (y1 - y0 < minH) {
    const mid = (y0 + y1) / 2;
    y0 = mid - minH / 2;
    y1 = mid + minH / 2;
  }
  if (x0 < 0) {
    x1 -= x0;
    x0 = 0;
  }
  if (y0 < 0) {
    y1 -= y0;
    y0 = 0;
  }
  if (x1 > page.widthPt) {
    const over = x1 - page.widthPt;
    x0 = Math.max(0, x0 - over);
    x1 = page.widthPt;
  }
  if (y1 > page.heightPt) {
    const over = y1 - page.heightPt;
    y0 = Math.max(0, y0 - over);
    y1 = page.heightPt;
  }
  return [x0, y0, x1, y1];
}

function applyResize(
  start: [number, number, number, number],
  dxPt: number,
  dyPt: number,
  handle: HandleId,
): [number, number, number, number] {
  let [x0, y0, x1, y1] = start;
  switch (handle) {
    case "nw":
      x0 += dxPt;
      y0 += dyPt;
      break;
    case "n":
      y0 += dyPt;
      break;
    case "ne":
      x1 += dxPt;
      y0 += dyPt;
      break;
    case "e":
      x1 += dxPt;
      break;
    case "se":
      x1 += dxPt;
      y1 += dyPt;
      break;
    case "s":
      y1 += dyPt;
      break;
    case "sw":
      x0 += dxPt;
      y1 += dyPt;
      break;
    case "w":
      x0 += dxPt;
      break;
  }
  if (x1 < x0) {
    const tmp = x0;
    x0 = x1;
    x1 = tmp;
  }
  if (y1 < y0) {
    const tmp = y0;
    y0 = y1;
    y1 = tmp;
  }
  return [x0, y0, x1, y1];
}

export function ResizeHandles({ fragId, bbox, cssScale, page }: Props) {
  const updateEdit = useDocumentStore((s) => s.updateEdit);
  const dragRef = useRef<DragState | null>(null);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>, handle: HandleId) => {
      e.preventDefault();
      e.stopPropagation();
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      dragRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        startBBox: [bbox[0], bbox[1], bbox[2], bbox[3]],
        handle,
      };
    },
    [bbox],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag) return;
      e.preventDefault();
      e.stopPropagation();
      const dxPx = e.clientX - drag.startX;
      const dyPx = e.clientY - drag.startY;
      const dxPt = dxPx / cssScale;
      const dyPt = dyPx / cssScale;
      const next = applyResize(drag.startBBox, dxPt, dyPt, drag.handle);
      const clamped = clampBBox(next, page);
      updateEdit(fragId, { newBBox: clamped });
    },
    [cssScale, page, fragId, updateEdit],
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

  return (
    <>
      {HANDLES.map((h) => (
        <div
          key={h.id}
          data-handle={h.id}
          onPointerDown={(e) => onPointerDown(e, h.id)}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onMouseDown={(e) => e.stopPropagation()}
          style={{
            position: "absolute",
            width: HANDLE_SIZE,
            height: HANDLE_SIZE,
            background: "white",
            border: "1px solid #4a90e2",
            borderRadius: 2,
            cursor: h.cursor,
            zIndex: 20,
            ...h.style,
          }}
        />
      ))}
    </>
  );
}
