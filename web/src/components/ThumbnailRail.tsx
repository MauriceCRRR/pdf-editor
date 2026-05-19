import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MoreHorizontal, Plus } from "lucide-react";
import type { PageData } from "../lib/api";
import type { PDFDocumentProxy } from "../lib/pdfjs";
import { useDocumentStore } from "../state/useDocumentStore";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { PdfPage } from "./PdfPage";

type Props = {
  pdf: PDFDocumentProxy;
  pages: PageData[];
};

type MenuState = {
  x: number;
  y: number;
  pageIndex: number;
};

type DropTarget = {
  overIndex: number;
  position: "above" | "below";
};

export function ThumbnailRail({ pdf, pages }: Props) {
  const addBlankPage = useDocumentStore((s) => s.addBlankPage);
  const removePage = useDocumentStore((s) => s.removePage);
  const reorderPages = useDocumentStore((s) => s.reorderPages);
  const isSaving = useDocumentStore((s) => s.isSaving);

  const [menu, setMenu] = useState<MenuState | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);
  const [draggingIndex, setDraggingIndex] = useState<number | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);

  const pageCount = pages.length;

  const scrollToPage = useCallback((pageNumber: number) => {
    const el = document.getElementById(`page-${pageNumber}`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, []);

  const openMenu = useCallback(
    (e: React.MouseEvent, pageIndex: number) => {
      e.preventDefault();
      e.stopPropagation();
      setMenu({ x: e.clientX, y: e.clientY, pageIndex });
    },
    [],
  );

  const openMenuAt = useCallback(
    (x: number, y: number, pageIndex: number) => {
      setMenu({ x, y, pageIndex });
    },
    [],
  );

  const onThumbKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLButtonElement>, pageIndex: number) => {
      if (
        e.key === "ContextMenu" ||
        e.key === "Apps" ||
        (e.shiftKey && e.key === "F10")
      ) {
        e.preventDefault();
        e.stopPropagation();
        const r = e.currentTarget.getBoundingClientRect();
        openMenuAt(r.right, r.top, pageIndex);
      }
    },
    [openMenuAt],
  );

  const swapAndReorder = useCallback(
    (from: number, to: number) => {
      if (from === to) return;
      const next: number[] = pages.map((p) => p.index);
      const tmp = next[from];
      next[from] = next[to];
      next[to] = tmp;
      void reorderPages(next);
    },
    [pages, reorderPages],
  );

  const moveTo = useCallback(
    (from: number, insertAt: number) => {
      if (from === insertAt) return;
      const order = pages.map((p) => p.index);
      const [moved] = order.splice(from, 1);
      const adjusted = from < insertAt ? insertAt - 1 : insertAt;
      order.splice(adjusted, 0, moved);
      if (order.every((v, i) => v === pages[i].index)) return;
      void reorderPages(order);
    },
    [pages, reorderPages],
  );

  const onAppend = useCallback(() => {
    void addBlankPage(pageCount);
  }, [addBlankPage, pageCount]);

  const menuItems = useMemo<ContextMenuItem[] | null>(() => {
    if (!menu) return null;
    const idx = menu.pageIndex;
    return [
      {
        label: "Insert blank page above",
        onSelect: () => void addBlankPage(idx),
      },
      {
        label: "Insert blank page below",
        onSelect: () => void addBlankPage(idx + 1),
      },
      {
        label: "Move up",
        disabled: idx === 0,
        onSelect: () => swapAndReorder(idx, idx - 1),
      },
      {
        label: "Move down",
        disabled: idx === pageCount - 1,
        onSelect: () => swapAndReorder(idx, idx + 1),
      },
      {
        label: "Delete page",
        danger: true,
        disabled: pageCount <= 1,
        onSelect: () => setConfirmDelete(idx),
      },
    ];
  }, [menu, pageCount, addBlankPage, swapAndReorder]);

  return (
    <aside className="relative w-40 shrink-0 overflow-y-auto border-r border-gray-200 bg-gray-50 p-3">
      <ul
        role="listbox"
        aria-label="Document pages"
        aria-orientation="vertical"
        className="flex flex-col gap-3"
      >
        {pages.map((p, i) => {
          const pageNumber = p.index + 1;
          const isDragging = draggingIndex === i;
          const isDropTarget = dropTarget?.overIndex === i;
          const showTopLine = isDropTarget && dropTarget?.position === "above";
          const showBottomLine = isDropTarget && dropTarget?.position === "below";
          return (
            <li
              key={p.index}
              className="relative"
              draggable
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("text/plain", String(i));
                setDraggingIndex(i);
              }}
              onDragOver={(e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                const rect = e.currentTarget.getBoundingClientRect();
                const midpoint = rect.top + rect.height / 2;
                const position: "above" | "below" =
                  e.clientY < midpoint ? "above" : "below";
                if (
                  dropTarget?.overIndex !== i ||
                  dropTarget?.position !== position
                ) {
                  setDropTarget({ overIndex: i, position });
                }
              }}
              onDragLeave={(e) => {
                const next = e.relatedTarget as Node | null;
                if (next && (e.currentTarget as HTMLElement).contains(next)) {
                  return;
                }
                setDropTarget((curr) => (curr?.overIndex === i ? null : curr));
              }}
              onDrop={(e) => {
                e.preventDefault();
                const raw = e.dataTransfer.getData("text/plain");
                const from = parseInt(raw, 10);
                setDropTarget(null);
                setDraggingIndex(null);
                if (Number.isNaN(from)) return;
                const insertAt =
                  e.clientY <
                  e.currentTarget.getBoundingClientRect().top +
                    e.currentTarget.getBoundingClientRect().height / 2
                    ? i
                    : i + 1;
                moveTo(from, insertAt);
              }}
              onDragEnd={() => {
                setDraggingIndex(null);
                setDropTarget(null);
              }}
            >
              {showTopLine ? (
                <span className="absolute inset-x-0 -top-1.5 h-0.5 rounded-full bg-blue-500" />
              ) : null}
              {showBottomLine ? (
                <span className="absolute inset-x-0 -bottom-1.5 h-0.5 rounded-full bg-blue-500" />
              ) : null}
              <div
                className={[
                  "group relative flex w-full flex-col items-center gap-1 rounded-md border bg-white p-2",
                  isDragging
                    ? "border-blue-400 opacity-40"
                    : "border-gray-200 hover:border-gray-400",
                ].join(" ")}
              >
                <button
                  type="button"
                  role="option"
                  aria-selected={false}
                  aria-label={`Page ${pageNumber} of ${pageCount}`}
                  onClick={() => scrollToPage(pageNumber)}
                  onContextMenu={(e) => openMenu(e, i)}
                  onKeyDown={(e) => onThumbKeyDown(e, i)}
                  aria-haspopup="menu"
                  className="flex w-full flex-col items-center gap-1"
                >
                  <ThumbnailSlot pdf={pdf} pageNumber={pageNumber} />
                  <span className="text-xs text-gray-500">{pageNumber}</span>
                </button>
                <button
                  type="button"
                  aria-label={`Page ${pageNumber} options`}
                  onClick={(e) => openMenu(e, i)}
                  className="absolute right-1 top-1 hidden h-6 w-6 items-center justify-center rounded-md bg-white/80 text-gray-600 shadow-sm group-hover:flex hover:bg-white"
                >
                  <MoreHorizontal size={14} aria-hidden="true" />
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      <button
        type="button"
        onClick={onAppend}
        disabled={isSaving}
        className={[
          "mt-3 flex w-full items-center justify-center gap-1 rounded-md border border-dashed px-2 py-2 text-xs font-medium transition-colors",
          isSaving
            ? "cursor-not-allowed border-gray-200 bg-gray-50 text-gray-400"
            : "border-gray-300 bg-white text-gray-600 hover:border-gray-500 hover:text-gray-900",
        ].join(" ")}
      >
        <Plus size={14} aria-hidden="true" />
        <span>Add page</span>
      </button>
      {menu && menuItems ? (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems}
          onClose={() => setMenu(null)}
        />
      ) : null}
      {confirmDelete !== null ? (
        <DeleteConfirm
          pageNumber={confirmDelete + 1}
          onCancel={() => setConfirmDelete(null)}
          onConfirm={() => {
            const idx = confirmDelete;
            setConfirmDelete(null);
            void removePage(idx);
          }}
        />
      ) : null}
    </aside>
  );
}

function ThumbnailSlot({
  pdf,
  pageNumber,
}: {
  pdf: PDFDocumentProxy;
  pageNumber: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (visible) return;
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setVisible(true);
            observer.disconnect();
            break;
          }
        }
      },
      { rootMargin: "200px 0px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [visible]);

  return (
    <div ref={ref} className="flex w-full justify-center">
      {visible ? (
        <PdfPage pdf={pdf} pageNumber={pageNumber} scale={0.2} thumbnail />
      ) : (
        <div className="h-32 w-24 animate-pulse rounded bg-gray-100" />
      )}
    </div>
  );
}

function DeleteConfirm({
  pageNumber,
  onCancel,
  onConfirm,
}: {
  pageNumber: number;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
      <div className="w-full max-w-sm rounded-lg border border-gray-200 bg-white p-5 shadow-lg">
        <h3 className="mb-2 text-base font-semibold text-gray-900">Delete page?</h3>
        <p className="mb-4 text-sm text-gray-600">
          Page {pageNumber} will be removed. This cannot be undone after saving.
        </p>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700"
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}
