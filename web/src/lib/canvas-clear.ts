export function clearCanvasRegion(
  canvas: HTMLCanvasElement,
  rect: { left: number; top: number; width: number; height: number },
  dpr: number,
): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const x = Math.floor(rect.left * dpr);
  const y = Math.floor(rect.top * dpr);
  const w = Math.ceil(rect.width * dpr);
  const h = Math.ceil(rect.height * dpr);
  ctx.save();
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(x, y, w, h);
  ctx.restore();
}
