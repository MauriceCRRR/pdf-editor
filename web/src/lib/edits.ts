// All colorRgb tuples in this codebase are floats in [0, 1]. Conversion to/from 0..255 happens only at the CSS/hex boundary.
import type { Align, Edit, Fragment, PageData, SpanDelta } from "./api";

export type EffectiveStyle = {
  newText: string;
  fontRef: string | null;
  size: number;
  colorRgb: [number, number, number];
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strikethrough: boolean;
  align: Align;
  newBBox: [number, number, number, number];
  originalBBox: [number, number, number, number];
  // When present, the fragment has per-span styling. The uniform fields above
  // mirror the first span's style so legacy consumers (inactive rendering,
  // color picker preview) still work.
  newSpans?: SpanDelta[];
};

export function buildBaselineEdit(
  fragment: Fragment,
  pageIndex: number,
): Edit {
  const span = fragment.spans[0];
  const newSpans: SpanDelta[] = fragment.spans.map((s) => ({
    text: s.text,
    fontRef: s.fontRef ?? null,
    size: s.size,
    colorRgb: s.colorRgb,
    bold: s.bold,
    italic: s.italic,
    underline: false,
    strikethrough: false,
  }));
  const newText = newSpans.length > 0
    ? newSpans.map((s) => s.text).join("")
    : fragment.text;
  return {
    fragId: fragment.id,
    pageIndex,
    originalBBox: fragment.bbox,
    newBBox: fragment.bbox,
    newText,
    fontRef: span?.fontRef ?? null,
    size: span?.size ?? 12,
    colorRgb: span?.colorRgb ?? [0, 0, 0],
    bold: span?.bold ?? false,
    italic: span?.italic ?? false,
    underline: false,
    strikethrough: false,
    align: "left",
    newSpans,
  };
}

export function getEffectiveStyle(
  fragment: Fragment,
  edit: Edit | undefined,
): EffectiveStyle {
  const span = fragment.spans[0];
  const baseSize = span?.size ?? 12;
  const baseColor: [number, number, number] = span?.colorRgb ?? [0, 0, 0];
  // When edit has multi-span styling, the "uniform" effective style mirrors
  // the first span so that the inactive (non-editing) render and color picker
  // continue to work. Active editing in FragBox walks newSpans directly.
  const firstNewSpan = edit?.newSpans && edit.newSpans.length > 0
    ? edit.newSpans[0]
    : undefined;
  return {
    newText: edit?.newText ?? fragment.text,
    fontRef: firstNewSpan?.fontRef ?? edit?.fontRef ?? span?.fontRef ?? null,
    size: firstNewSpan?.size ?? edit?.size ?? baseSize,
    colorRgb: firstNewSpan?.colorRgb ?? edit?.colorRgb ?? baseColor,
    bold: firstNewSpan?.bold ?? edit?.bold ?? span?.bold ?? false,
    italic: firstNewSpan?.italic ?? edit?.italic ?? span?.italic ?? false,
    underline: firstNewSpan?.underline ?? edit?.underline ?? false,
    strikethrough: firstNewSpan?.strikethrough ?? edit?.strikethrough ?? false,
    align: edit?.align ?? "left",
    newBBox: edit?.newBBox ?? fragment.bbox,
    originalBBox: edit?.originalBBox ?? fragment.bbox,
    newSpans: edit?.newSpans,
  };
}

export function findFragmentById(
  pages: PageData[],
  fragId: string,
): { pageIndex: number; fragment: Fragment } | null {
  for (const page of pages) {
    const fragment = page.fragments.find((f) => f.id === fragId);
    if (fragment) {
      return { pageIndex: page.index, fragment };
    }
  }
  return null;
}

export function rgbToCss(rgb: [number, number, number]): string {
  const to255 = (n: number) =>
    Math.max(0, Math.min(255, Math.round(n * 255)));
  return `rgb(${to255(rgb[0])}, ${to255(rgb[1])}, ${to255(rgb[2])})`;
}

export function rgbToHex(rgb: [number, number, number]): string {
  const to255 = (n: number) =>
    Math.max(0, Math.min(255, Math.round(n * 255)));
  const hex = (n: number) => to255(n).toString(16).padStart(2, "0");
  return `#${hex(rgb[0])}${hex(rgb[1])}${hex(rgb[2])}`;
}

export function hexToRgb(hex: string): [number, number, number] | null {
  const cleaned = hex.trim().replace(/^#/, "");
  if (cleaned.length !== 3 && cleaned.length !== 6) return null;
  const full =
    cleaned.length === 3
      ? cleaned
          .split("")
          .map((c) => c + c)
          .join("")
      : cleaned;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return null;
  return [r / 255, g / 255, b / 255];
}
