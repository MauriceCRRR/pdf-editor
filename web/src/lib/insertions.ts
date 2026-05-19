import type {
  ImageInsertion,
  Insertion,
  LineInsertion,
  PageData,
  Rgb,
  ShapeInsertion,
  TextInsertion,
} from "./api";

export const MIN_BOX_WIDTH_PT = 20;
export const MIN_BOX_HEIGHT_PT = 10;
export const MIN_LINE_LENGTH_PT = 8;

export const DEFAULT_TEXT_SIZE = 14;
export const DEFAULT_TEXT_FONT_KEY = "arialmt";
export const DEFAULT_SHAPE_STROKE_WIDTH = 1;
export const DEFAULT_LINE_STROKE_WIDTH = 1.5;
export const BLACK_RGB: Rgb = [0, 0, 0];

export const FONT_OPTIONS: ReadonlyArray<{
  label: string;
  regular: string;
  bold: string;
  italic: string;
  boldItalic: string;
}> = [
  {
    label: "Arial",
    regular: "arialmt",
    bold: "arial-boldmt",
    italic: "arial-italicmt",
    boldItalic: "arial-bolditalicmt",
  },
  {
    label: "Times New Roman",
    regular: "timesnewromanpsmt",
    bold: "timesnewromanps-boldmt",
    italic: "timesnewromanps-italicmt",
    boldItalic: "timesnewromanps-bolditalicmt",
  },
  {
    label: "Courier New",
    regular: "couriernewpsmt",
    bold: "couriernewps-boldmt",
    italic: "couriernewps-italicmt",
    boldItalic: "couriernewps-bolditalicmt",
  },
  {
    label: "Georgia",
    regular: "georgia",
    bold: "georgia-bold",
    italic: "georgia-italic",
    boldItalic: "georgia-bolditalic",
  },
  {
    label: "Verdana",
    regular: "verdana",
    bold: "verdana-bold",
    italic: "verdana-italic",
    boldItalic: "verdana-bolditalic",
  },
  {
    label: "Comic Sans",
    regular: "comicsansms",
    bold: "comicsansms-bold",
    italic: "comicsansms-italic",
    boldItalic: "comicsansms-bolditalic",
  },
];

export function fontKeyFor(
  baseKey: string,
  bold: boolean,
  italic: boolean,
): string {
  const family = FONT_OPTIONS.find(
    (f) =>
      f.regular === baseKey ||
      f.bold === baseKey ||
      f.italic === baseKey ||
      f.boldItalic === baseKey,
  );
  if (!family) return baseKey;
  if (bold && italic) return family.boldItalic;
  if (bold) return family.bold;
  if (italic) return family.italic;
  return family.regular;
}

export function familyLabelForFontKey(key: string): string {
  const family = FONT_OPTIONS.find(
    (f) =>
      f.regular === key ||
      f.bold === key ||
      f.italic === key ||
      f.boldItalic === key,
  );
  return family?.label ?? "Arial";
}

export function regularKeyForFamily(key: string): string {
  const family = FONT_OPTIONS.find(
    (f) =>
      f.regular === key ||
      f.bold === key ||
      f.italic === key ||
      f.boldItalic === key,
  );
  return family?.regular ?? FONT_OPTIONS[0].regular;
}

export function rgbToCssTriple(rgb: Rgb): string {
  const r = Math.round(Math.max(0, Math.min(1, rgb[0])) * 255);
  const g = Math.round(Math.max(0, Math.min(1, rgb[1])) * 255);
  const b = Math.round(Math.max(0, Math.min(1, rgb[2])) * 255);
  return `rgb(${r} ${g} ${b})`;
}

export function rgb255ToRgb01(rgb: Rgb): Rgb {
  return [rgb[0] / 255, rgb[1] / 255, rgb[2] / 255];
}

export function rgb01ToRgb255(rgb: Rgb): Rgb {
  return [
    Math.round(Math.max(0, Math.min(1, rgb[0])) * 255),
    Math.round(Math.max(0, Math.min(1, rgb[1])) * 255),
    Math.round(Math.max(0, Math.min(1, rgb[2])) * 255),
  ];
}

export function generateInsertionId(type: Insertion["type"]): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${type}-${Date.now().toString(36)}-${rand}`;
}

type BoxDrag = {
  start: [number, number];
  end: [number, number];
};

function normalizeBox(drag: BoxDrag): [number, number, number, number] {
  const [sx, sy] = drag.start;
  const [ex, ey] = drag.end;
  const x0 = Math.min(sx, ex);
  const y0 = Math.min(sy, ey);
  const x1 = Math.max(sx, ex);
  const y1 = Math.max(sy, ey);
  return [x0, y0, x1, y1];
}

function snapBoxMin(
  bbox: [number, number, number, number],
  minW: number,
  minH: number,
): [number, number, number, number] {
  const [x0, y0] = bbox;
  let x1 = bbox[2];
  let y1 = bbox[3];
  if (x1 - x0 < minW) x1 = x0 + minW;
  if (y1 - y0 < minH) y1 = y0 + minH;
  return [x0, y0, x1, y1];
}

export function clampBoxToPage(
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

export function clampPointToPage(
  pt: [number, number],
  page: PageData,
): [number, number] {
  return [
    Math.max(0, Math.min(page.widthPt, pt[0])),
    Math.max(0, Math.min(page.heightPt, pt[1])),
  ];
}

export function buildBoxFromDrag(
  drag: BoxDrag,
  page: PageData,
): [number, number, number, number] {
  const normalized = normalizeBox(drag);
  const snapped = snapBoxMin(normalized, MIN_BOX_WIDTH_PT, MIN_BOX_HEIGHT_PT);
  return clampBoxToPage(snapped, page);
}

export function buildLineFromDrag(
  drag: BoxDrag,
  page: PageData,
): { from: [number, number]; to: [number, number] } {
  const start = clampPointToPage([drag.start[0], drag.start[1]], page);
  let end = clampPointToPage([drag.end[0], drag.end[1]], page);
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const len = Math.hypot(dx, dy);
  if (len < MIN_LINE_LENGTH_PT) {
    if (len === 0) {
      end = clampPointToPage([start[0] + MIN_LINE_LENGTH_PT, start[1]], page);
    } else {
      const scale = MIN_LINE_LENGTH_PT / len;
      end = clampPointToPage(
        [start[0] + dx * scale, start[1] + dy * scale],
        page,
      );
    }
  }
  return { from: start, to: end };
}

export function makeTextInsertion(
  pageIndex: number,
  bbox: [number, number, number, number],
): TextInsertion {
  return {
    id: generateInsertionId("text"),
    type: "text",
    pageIndex,
    bbox,
    text: "",
    fontKey: DEFAULT_TEXT_FONT_KEY,
    size: DEFAULT_TEXT_SIZE,
    colorRgb: BLACK_RGB,
    bold: false,
    italic: false,
    underline: false,
    strikethrough: false,
    align: "left",
  };
}

export function makeShapeInsertion(
  type: "rectangle" | "ellipse",
  pageIndex: number,
  bbox: [number, number, number, number],
): ShapeInsertion {
  return {
    id: generateInsertionId(type),
    type,
    pageIndex,
    bbox,
    strokeRgb: BLACK_RGB,
    fillRgb: null,
    strokeWidth: DEFAULT_SHAPE_STROKE_WIDTH,
  };
}

export function makeLineInsertion(
  type: "line" | "arrow",
  pageIndex: number,
  from: [number, number],
  to: [number, number],
): LineInsertion {
  return {
    id: generateInsertionId(type),
    type,
    pageIndex,
    fromPt: from,
    toPt: to,
    strokeRgb: BLACK_RGB,
    strokeWidth: DEFAULT_LINE_STROKE_WIDTH,
  };
}

export function makeImageInsertion(
  pageIndex: number,
  bbox: [number, number, number, number],
  imageRef: string,
): ImageInsertion {
  return {
    id: generateInsertionId("image"),
    type: "image",
    pageIndex,
    bbox,
    imageRef,
  };
}

