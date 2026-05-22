import { useCallback, useEffect, useRef } from "react";
import type { Edit, Fragment, PageData, SpanDelta } from "../lib/api";
import { getEffectiveStyle, rgbToCss } from "../lib/edits";
import { isTextInSubset } from "../lib/fonts";
import { useDocumentStore } from "../state/useDocumentStore";
import { useToastStore } from "../state/useToastStore";
import { ResizeHandles } from "./ResizeHandles";

type Props = {
  fragment: Fragment;
  rect: { left: number; top: number; width: number; height: number };
  interactive: boolean;
  isActive: boolean;
  edit: Edit | undefined;
  onActivate: () => void;
  onDeactivate: () => void;
  fontFamily: string;
  cssScale: number;
  page: PageData;
};

const EDGE_PX = 6;

type DragState = {
  startX: number;
  startY: number;
  startBBox: [number, number, number, number];
};

function clampBBoxToPage(
  bbox: [number, number, number, number],
  page: PageData,
): [number, number, number, number] {
  let [x0, y0, x1, y1] = bbox;
  const w = x1 - x0;
  const h = y1 - y0;
  if (x0 < 0) {
    x0 = 0;
    x1 = w;
  }
  if (y0 < 0) {
    y0 = 0;
    y1 = h;
  }
  if (x1 > page.widthPt) {
    x1 = page.widthPt;
    x0 = x1 - w;
  }
  if (y1 > page.heightPt) {
    y1 = page.heightPt;
    y0 = y1 - h;
  }
  return [x0, y0, x1, y1];
}

function textDecoration(underline: boolean, strikethrough: boolean): string {
  const parts: string[] = [];
  if (underline) parts.push("underline");
  if (strikethrough) parts.push("line-through");
  return parts.length === 0 ? "none" : parts.join(" ");
}

function saveSelectionOffset(el: HTMLElement): number {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return 0;
  const range = sel.getRangeAt(0);
  if (!el.contains(range.endContainer)) return 0;
  const pre = range.cloneRange();
  pre.selectNodeContents(el);
  pre.setEnd(range.endContainer, range.endOffset);
  return pre.toString().length;
}

function restoreSelectionOffset(el: HTMLElement, offset: number): void {
  let remaining = offset;
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let node: Node | null = walker.nextNode();
  let lastNode: Node | null = null;
  let lastLen = 0;
  while (node) {
    const len = node.textContent?.length ?? 0;
    if (remaining <= len) {
      const range = document.createRange();
      range.setStart(node, remaining);
      range.collapse(true);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
      return;
    }
    remaining -= len;
    lastNode = node;
    lastLen = len;
    node = walker.nextNode();
  }
  // Walked past the end — clamp to the end of the last text node.
  if (lastNode) {
    const range = document.createRange();
    range.setStart(lastNode, lastLen);
    range.collapse(true);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  }
}

function applySpanDeltaInlineStyle(el: HTMLElement, s: SpanDelta): void {
  el.style.fontWeight = s.bold ? "700" : "400";
  el.style.fontStyle = s.italic ? "italic" : "normal";
  el.style.textDecoration = textDecoration(s.underline, s.strikethrough);
  el.style.color = rgbToCss(s.colorRgb);
}

export function FragBox({
  fragment,
  rect,
  interactive,
  isActive,
  edit,
  onActivate,
  onDeactivate,
  fontFamily,
  cssScale,
  page,
}: Props) {
  const editableRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const xobjectToastSeenRef = useRef<boolean>(false);
  const composingRef = useRef<boolean>(false);
  const effective = getEffectiveStyle(fragment, edit);
  const initialText = effective.newText;
  const hasPendingEdit = edit !== undefined;
  const isFormField = fragment.isFormField === true;
  const isFromXObject = fragment.isFromXObject === true && !isFormField;
  // Form fields are read-only in v1 — force-disable interactivity regardless
  // of the parent's edit-mode signal.
  const effectiveInteractive = isFormField ? false : interactive;

  // Resolve the spans to render in the editable element. When the edit has no
  // per-span styling (legacy / single-span fragments), synthesize a one-span
  // array from the uniform effective style so the active branch has a single
  // code path.
  const effectiveSpans: SpanDelta[] = effective.newSpans && effective.newSpans.length > 0
    ? effective.newSpans
    : [{
        text: effective.newText,
        fontRef: effective.fontRef,
        size: effective.size,
        colorRgb: effective.colorRgb,
        bold: effective.bold,
        italic: effective.italic,
        underline: effective.underline,
        strikethrough: effective.strikethrough,
      }];

  // Helper: rebuild the editable element's children from a SpanDelta array.
  // Preserves the caret position across the rebuild.
  const rebuildEditableChildren = useCallback(
    (el: HTMLElement, spans: SpanDelta[]) => {
      const offset = saveSelectionOffset(el);
      const children: HTMLSpanElement[] = spans.map((s, i) => {
        const span = document.createElement("span");
        span.setAttribute("data-span-idx", String(i));
        applySpanDeltaInlineStyle(span, s);
        // textContent (vs innerText) preserves whitespace exactly.
        span.textContent = s.text;
        return span;
      });
      el.replaceChildren(...children);
      restoreSelectionOffset(el, offset);
    },
    [],
  );

  useEffect(() => {
    if (!isActive) return;
    const el = editableRef.current;
    if (!el) return;
    rebuildEditableChildren(el, effectiveSpans);
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
    if (el.textContent !== initialText) {
      rebuildEditableChildren(el, effectiveSpans);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive, initialText]);

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
      const startBBox = effective.newBBox;
      dragRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        startBBox: [startBBox[0], startBBox[1], startBBox[2], startBBox[3]],
      };
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    },
    [isActive, isOnEdge, effective.newBBox],
  );

  const onDragPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag) return;
      e.preventDefault();
      e.stopPropagation();
      const dxPx = e.clientX - drag.startX;
      const dyPx = e.clientY - drag.startY;
      const dxPt = dxPx / cssScale;
      const dyPt = dyPx / cssScale;
      const [x0, y0, x1, y1] = drag.startBBox;
      const next: [number, number, number, number] = [
        x0 + dxPt,
        y0 + dyPt,
        x1 + dxPt,
        y1 + dyPt,
      ];
      const clamped = clampBBoxToPage(next, page);
      useDocumentStore.getState().updateEdit(fragment.id, { newBBox: clamped });
    },
    [cssScale, page, fragment.id],
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
    ? "outline outline-2 outline-[#4a90e2]"
    : hasPendingEdit
      ? "border border-solid border-amber-500"
      : isFormField
        ? "border border-dashed border-amber-400"
        : "border border-dotted border-[#4a90e2] hover:border-solid";

  const baseClass = [
    "absolute box-border",
    borderClass,
    effectiveInteractive && !isActive ? "cursor-text" : "",
    isFormField ? "cursor-not-allowed" : "",
  ].filter(Boolean).join(" ");

  const baseStyle: React.CSSProperties = {
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    // Opaque white when active or edited so the original PDF text underneath is
    // hidden without destructively clearing the canvas. Inactive untouched
    // fragments stay transparent so the canvas shows through normally.
    // Form fields stay transparent so the user can still see the widget below.
    background:
      isFormField ? undefined : isActive || hasPendingEdit ? "#ffffff" : undefined,
  };

  const rot = fragment.rotation ?? 0;
  // Apply the rotation transform only to the text content, not the container
  // box, so hit-testing for clicks/drags stays axis-aligned.
  const rotationTransform = rot !== 0 ? `rotate(${rot}deg)` : undefined;
  const writingMode = (fragment.writingMode ?? "horizontal-tb") as React.CSSProperties["writingMode"];
  const isVertical = (fragment.writingMode ?? "horizontal-tb") !== "horizontal-tb";

  // Match the CSS line box to PyMuPDF's reported bbox (= font's intrinsic
  // ascent + descent in em units). With line-height: 1 the baseline sat at
  // (size + ascent − descent) / 2 from the top, ~1–2 px above PyMuPDF's
  // baseline (ascent × size), which made the text jump up on activation.
  const naturalSize = fragment.spans[0]?.size ?? effective.size;
  const naturalHeightPt = fragment.bbox[3] - fragment.bbox[1];
  const lineHeightRatio = naturalSize > 0 ? naturalHeightPt / naturalSize : 1.2;

  const fontStyle: React.CSSProperties = {
    fontFamily,
    fontSize: `${effective.size * cssScale}px`,
    color: rgbToCss(effective.colorRgb),
    fontWeight: effective.bold ? 700 : 400,
    fontStyle: effective.italic ? "italic" : "normal",
    textDecoration: textDecoration(effective.underline, effective.strikethrough),
    textAlign: effective.align,
    lineHeight: lineHeightRatio,
    whiteSpace: "pre",
    transform: rotationTransform,
    transformOrigin: "top left",
    writingMode,
  };

  if (!isActive) {
    const fragTitle = isFormField
      ? `Form field${fragment.formFieldName ? ` — ${fragment.formFieldName}` : ""} (Phase 2 — read only)`
      : fragment.text;
    const ariaLabel = isFormField
      ? `Form field (read-only): ${fragment.text}`
      : `Click to edit text: ${fragment.text}`;
    return (
      <div
        data-fragment-id={fragment.id}
        title={fragTitle}
        role={isFormField ? "presentation" : "button"}
        tabIndex={effectiveInteractive ? 0 : -1}
        aria-label={ariaLabel}
        aria-disabled={!effectiveInteractive}
        style={baseStyle}
        className={baseClass}
        onKeyDown={(e) => {
          if (!effectiveInteractive) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            e.stopPropagation();
            onActivate();
          }
        }}
        onMouseDown={(e) => {
          if (!effectiveInteractive) return;
          if (isFromXObject && !xobjectToastSeenRef.current) {
            xobjectToastSeenRef.current = true;
            useToastStore.getState().pushToast({
              kind: "info",
              message:
                "This text appears in a shared template; editing here only changes this page.",
            });
          }
          e.preventDefault();
          e.stopPropagation();
          onActivate();
        }}
      >
        {isFormField ? (
          <span className="absolute -top-5 left-0 px-1.5 py-0.5 bg-amber-100 border border-amber-300 rounded text-[10px] text-amber-900 whitespace-nowrap pointer-events-none">
            Form field — Phase 2
          </span>
        ) : null}
        {isFromXObject ? (
          <span className="absolute -top-5 right-0 px-1.5 py-0.5 bg-sky-100 border border-sky-300 rounded text-[10px] text-sky-900 whitespace-nowrap pointer-events-none">
            Shared content
          </span>
        ) : null}
        {hasPendingEdit ? (
          <span
            style={{
              ...fontStyle,
              display: "block",
              width: "100%",
              height: "100%",
              overflow: "hidden",
              pointerEvents: "none",
              userSelect: "none",
              padding: 0,
              margin: 0,
            }}
          >
            {effective.newText}
          </span>
        ) : null}
      </div>
    );
  }

  // While editing, the contentEditable element must use horizontal writing mode
  // (caret support for vertical-rl is limited across browsers) and is shown
  // without rotation. The chip overlays inform the user that orientation will
  // not be preserved at save time.
  const editableFontStyle: React.CSSProperties = {
    ...fontStyle,
    transform: undefined,
    transformOrigin: undefined,
    writingMode: "horizontal-tb",
  };

  return (
    <div
      ref={containerRef}
      data-fragment-id={fragment.id}
      style={baseStyle}
      className={`${baseClass} group`}
      onPointerDown={onDragPointerDown}
      onPointerMove={onDragPointerMove}
      onPointerUp={onDragPointerUp}
      onPointerCancel={onDragPointerUp}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {rot !== 0 ? (
        <span className="absolute -top-5 left-0 px-1.5 py-0.5 bg-slate-200 border border-slate-400 rounded text-[10px] text-slate-700 whitespace-nowrap pointer-events-none">
          Rotation locked
        </span>
      ) : null}
      {isVertical ? (
        <span
          className={[
            "absolute -top-5 px-1.5 py-0.5 bg-slate-200 border border-slate-400 rounded text-[10px] text-slate-700 whitespace-nowrap pointer-events-none",
            rot !== 0 ? "left-28" : "left-0",
          ].join(" ")}
        >
          Editing switches to horizontal
        </span>
      ) : null}
      <div
        ref={editableRef}
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="false"
        aria-label="Editing PDF text fragment"
        dir="ltr"
        spellCheck={false}
        onCompositionStart={() => {
          composingRef.current = true;
        }}
        onCompositionEnd={(e) => {
          composingRef.current = false;
          // Force an onInput-like rebuild now that the composed sequence is
          // committed to the DOM.
          e.currentTarget.dispatchEvent(
            new InputEvent("input", { bubbles: true }),
          );
        }}
        onInput={(e) => {
          if (composingRef.current) return;
          const el = e.currentTarget;
          // Merge adjacent text nodes so a stray text-node between styled
          // spans (e.g. after backspace) is consolidated.
          el.normalize();

          const baselineSpans = effectiveSpans;
          const newSpansOut: SpanDelta[] = [];

          for (const child of Array.from(el.childNodes)) {
            if (child.nodeType === Node.TEXT_NODE) {
              const text = child.textContent ?? "";
              if (!text) continue;
              const inherit =
                newSpansOut[newSpansOut.length - 1] ?? baselineSpans[0];
              if (inherit) newSpansOut.push({ ...inherit, text });
            } else if (
              child.nodeType === Node.ELEMENT_NODE
              && (child as Element).tagName === "SPAN"
            ) {
              const spanEl = child as HTMLElement;
              const idxRaw = spanEl.dataset.spanIdx;
              const idx = idxRaw !== undefined ? parseInt(idxRaw, 10) : -1;
              const orig = (Number.isFinite(idx) && idx >= 0
                ? baselineSpans[idx]
                : undefined) ?? baselineSpans[0];
              const text = spanEl.textContent ?? "";
              if (orig && text) newSpansOut.push({ ...orig, text });
            } else if (child.nodeType === Node.ELEMENT_NODE) {
              // <br> / <div> / other wrappers — flatten textContent and
              // inherit the previous span's style.
              const text = (child as HTMLElement).textContent ?? "";
              const inherit =
                newSpansOut[newSpansOut.length - 1] ?? baselineSpans[0];
              if (inherit && text) newSpansOut.push({ ...inherit, text });
            }
          }

          // Empty container — keep a single span with the first baseline
          // style so future typing reuses the original font.
          if (newSpansOut.length === 0 && baselineSpans[0]) {
            newSpansOut.push({
              ...baselineSpans[0],
              text: el.textContent ?? "",
            });
          }

          const newText = newSpansOut.map((s) => s.text).join("");
          const store = useDocumentStore.getState();
          const fontRef = effective.fontRef;
          if (fontRef) {
            const codepoints = store.availableCodepointsByRef.get(fontRef);
            if (codepoints) {
              const inSubset = isTextInSubset(newText, codepoints);
              store.markFragmentExpanded(fragment.id, !inSubset);
            }
          }
          // Auto-grow the bbox horizontally when typed text exceeds the
          // original width. Without this, contentEditable's overflow:hidden
          // scrolls to keep the caret in view, hiding the start of the text.
          const overflowPx = el.scrollWidth - el.clientWidth;
          let nextBBox: [number, number, number, number] | undefined;
          if (overflowPx > 0.5) {
            const [x0, y0, x1, y1] = effective.newBBox;
            const grownX1 = Math.min(page.widthPt, x1 + overflowPx / cssScale);
            if (grownX1 > x1 + 0.01) {
              nextBBox = [x0, y0, grownX1, y1];
            }
          }
          store.updateEdit(fragment.id, {
            newText,
            newSpans: newSpansOut,
            ...(nextBBox ? { newBBox: nextBBox } : {}),
          });
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onDeactivate();
          }
        }}
        onPaste={(e) => {
          e.preventDefault();
          const text = e.clipboardData.getData("text/plain");
          if (!text) return;
          // Prefer the built-in command which keeps the browser's undo stack
          // sane. Falls back to manual range insertion when execCommand is
          // unavailable (Firefox future versions, exotic browsers).
          let inserted = false;
          try {
            inserted = document.execCommand("insertText", false, text);
          } catch {
            inserted = false;
          }
          if (!inserted) {
            const sel = window.getSelection();
            if (sel && sel.rangeCount > 0) {
              const range = sel.getRangeAt(0);
              range.deleteContents();
              const node = document.createTextNode(text);
              range.insertNode(node);
              range.setStartAfter(node);
              range.collapse(true);
              sel.removeAllRanges();
              sel.addRange(range);
              e.currentTarget.dispatchEvent(new Event("input", { bubbles: true }));
            }
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
          ...editableFontStyle,
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
        <ResizeHandles
          fragId={fragment.id}
          bbox={effective.newBBox}
          cssScale={cssScale}
          page={page}
        />
      </div>
    </div>
  );
}
