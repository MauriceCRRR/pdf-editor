import { useEffect, useRef } from "react";

export type ContextMenuItem = {
  label: string;
  disabled?: boolean;
  danger?: boolean;
  onSelect: () => void;
};

type Props = {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
};

const MENU_WIDTH = 220;
const MENU_MIN_HEIGHT = 40;

export function ContextMenu({ x, y, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent): void => {
      if (!ref.current) return;
      if (!ref.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKey);
    };
  }, [onClose]);

  const vw = typeof window !== "undefined" ? window.innerWidth : 1024;
  const vh = typeof window !== "undefined" ? window.innerHeight : 768;
  const left = Math.min(x, vw - MENU_WIDTH - 8);
  const top = Math.min(y, vh - MENU_MIN_HEIGHT - 8);

  return (
    <div
      ref={ref}
      role="menu"
      style={{ left: `${left}px`, top: `${top}px`, width: `${MENU_WIDTH}px` }}
      className="fixed z-50 overflow-hidden rounded-md border border-gray-200 bg-white py-1 shadow-lg"
    >
      {items.map((item, idx) => {
        const colorClass = item.disabled
          ? "cursor-not-allowed text-gray-300"
          : item.danger
            ? "text-red-600 hover:bg-red-50"
            : "text-gray-800 hover:bg-gray-100";
        return (
          <button
            key={idx}
            type="button"
            role="menuitem"
            disabled={item.disabled}
            onClick={() => {
              if (item.disabled) return;
              item.onSelect();
              onClose();
            }}
            className={["block w-full px-3 py-1.5 text-left text-sm", colorClass].join(" ")}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
