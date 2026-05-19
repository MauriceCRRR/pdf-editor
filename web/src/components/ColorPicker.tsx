import { useEffect, useRef, useState } from "react";
import { hexToRgb, rgbToCss, rgbToHex } from "../lib/edits";

const SWATCHES: string[] = [
  "#000000",
  "#404040",
  "#808080",
  "#bfbfbf",
  "#ffffff",
  "#e02424",
  "#ed7d3a",
  "#f5c518",
  "#22c55e",
  "#14b8a6",
  "#3b82f6",
  "#6366f1",
  "#a855f7",
  "#ec4899",
  "#7c3aed",
  "#0ea5e9",
  "#84cc16",
  "#f97316",
  "#dc2626",
  "#111827",
];

type Props = {
  color: [number, number, number];
  onChange: (rgb: [number, number, number]) => void;
};

export function ColorPicker({ color, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (wrapperRef.current && target && !wrapperRef.current.contains(target)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocDown);
    return () => document.removeEventListener("mousedown", onDocDown);
  }, [open]);

  return (
    <div ref={wrapperRef} className="relative inline-block">
      <button
        type="button"
        aria-label="Pick color"
        onClick={() => setOpen((v) => !v)}
        className="inline-block h-7 w-7 rounded-full border border-gray-300"
        style={{ backgroundColor: rgbToCss(color) }}
        title={rgbToCss(color)}
      />
      {open ? (
        <ColorPickerPopover
          key={rgbToHex(color)}
          color={color}
          onChange={(rgb) => {
            onChange(rgb);
            setOpen(false);
          }}
        />
      ) : null}
    </div>
  );
}

function ColorPickerPopover({
  color,
  onChange,
}: {
  color: [number, number, number];
  onChange: (rgb: [number, number, number]) => void;
}) {
  const [hex, setHex] = useState(rgbToHex(color));

  const commitHex = () => {
    const rgb = hexToRgb(hex);
    if (rgb) {
      onChange(rgb);
    } else {
      setHex(rgbToHex(color));
    }
  };

  return (
    <div className="absolute left-0 top-9 z-30 w-56 rounded-md border border-gray-200 bg-white p-3 shadow-lg">
      <div className="grid grid-cols-5 gap-1.5">
        {SWATCHES.map((swatch) => {
          const rgb = hexToRgb(swatch);
          if (!rgb) return null;
          const isCurrent = rgbToHex(color).toLowerCase() === swatch.toLowerCase();
          return (
            <button
              key={swatch}
              type="button"
              onClick={() => onChange(rgb)}
              className={[
                "h-7 w-7 rounded-full border",
                isCurrent ? "border-gray-900 ring-2 ring-gray-900" : "border-gray-300",
              ].join(" ")}
              style={{ backgroundColor: swatch }}
              title={swatch}
            />
          );
        })}
      </div>
      <div className="mt-3 flex items-center gap-2">
        <label className="text-xs text-gray-500" htmlFor="hex-input">
          Hex
        </label>
        <input
          id="hex-input"
          type="text"
          value={hex}
          onChange={(e) => setHex(e.target.value)}
          onBlur={commitHex}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commitHex();
            }
          }}
          className="flex-1 rounded-md border border-gray-300 bg-white px-2 py-1 text-xs text-gray-800 focus:outline-none focus:ring-1 focus:ring-gray-900"
        />
      </div>
    </div>
  );
}
