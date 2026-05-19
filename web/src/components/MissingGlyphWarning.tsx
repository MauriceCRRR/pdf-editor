type Props = {
  rect: { left: number; top: number; width: number; height: number };
  fallbackFamily: string;
};

function primaryFamily(fallbackFamily: string): string {
  const first = fallbackFamily.split(",")[0]?.trim() ?? fallbackFamily;
  return first.replace(/^["']|["']$/g, "");
}

export function MissingGlyphWarning({ rect, fallbackFamily }: Props) {
  const family = primaryFamily(fallbackFamily);
  const style: React.CSSProperties = {
    left: `${rect.left}px`,
    top: `${rect.top + rect.height + 4}px`,
    maxWidth: `${Math.max(rect.width, 240)}px`,
  };
  return (
    <div
      role="status"
      aria-live="polite"
      style={style}
      className="pointer-events-none absolute z-10 flex items-center gap-1.5 rounded-md bg-amber-100 px-2 py-1 text-xs text-amber-900 shadow-sm"
    >
      <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-amber-500 text-[10px] font-bold text-white">
        !
      </span>
      <span>
        Font doesn&apos;t include this character. Using {family}.
      </span>
    </div>
  );
}
