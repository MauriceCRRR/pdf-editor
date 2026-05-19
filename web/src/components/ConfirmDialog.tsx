import { useEffect } from "react";
import { useConfirmStore } from "../state/useConfirmStore";

export function ConfirmDialog() {
  const open = useConfirmStore((s) => s.open);
  const count = useConfirmStore((s) => s.count);
  const respond = useConfirmStore((s) => s.respond);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        respond("cancel");
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, respond]);

  if (!open) return null;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Confirm unsaved changes"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
    >
      <div className="bg-white rounded-lg shadow-xl max-w-sm w-full mx-4 p-5">
        <h2 className="text-base font-semibold text-gray-900 mb-1">
          Unsaved edits
        </h2>
        <p className="text-sm text-gray-700 mb-4">
          You have {count} unsaved edit{count === 1 ? "" : "s"}. Page changes
          will clear them.
        </p>
        <div className="flex gap-2 justify-end">
          <button
            type="button"
            onClick={() => respond("cancel")}
            className="px-3 py-1.5 text-sm rounded border border-gray-300 hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => respond("discard")}
            className="px-3 py-1.5 text-sm rounded border border-red-300 text-red-700 hover:bg-red-50"
          >
            Discard
          </button>
          <button
            type="button"
            onClick={() => respond("save")}
            autoFocus
            className="px-3 py-1.5 text-sm rounded bg-blue-600 text-white hover:bg-blue-700"
          >
            Save &amp; continue
          </button>
        </div>
      </div>
    </div>
  );
}
