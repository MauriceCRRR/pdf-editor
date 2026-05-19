export function pdfBboxToCssRect(
  bbox: readonly [number, number, number, number],
  cssScale: number,
): { left: number; top: number; width: number; height: number } {
  const [x0, y0, x1, y1] = bbox;
  return {
    left: x0 * cssScale,
    top: y0 * cssScale,
    width: (x1 - x0) * cssScale,
    height: (y1 - y0) * cssScale,
  };
}

export function cssRectToPdfBbox(
  rect: { left: number; top: number; width: number; height: number },
  cssScale: number,
): [number, number, number, number] {
  const { left, top, width, height } = rect;
  return [
    left / cssScale,
    top / cssScale,
    (left + width) / cssScale,
    (top + height) / cssScale,
  ];
}

export function getCssScale(viewport: { scale: number }): number {
  const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
  return viewport.scale / dpr;
}

export function pdfPointToCss(
  pt: readonly [number, number],
  cssScale: number,
): { left: number; top: number } {
  return { left: pt[0] * cssScale, top: pt[1] * cssScale };
}
