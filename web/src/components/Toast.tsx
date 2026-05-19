import { X } from "lucide-react";
import { useToastStore, type Toast as ToastData } from "../state/useToastStore";

const KIND_STYLES: Record<ToastData["kind"], string> = {
  success: "bg-green-600",
  error: "bg-red-600",
  info: "bg-blue-600",
};

export function ToastViewport() {
  const toasts = useToastStore((s) => s.toasts);
  const dismissToast = useToastStore((s) => s.dismissToast);

  if (toasts.length === 0) return null;

  return (
    <div
      aria-live="polite"
      aria-atomic="true"
      className="pointer-events-none fixed bottom-4 right-4 z-50 flex flex-col gap-2"
    >
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} onDismiss={() => dismissToast(t.id)} />
      ))}
    </div>
  );
}

function ToastItem({
  toast,
  onDismiss,
}: {
  toast: ToastData;
  onDismiss: () => void;
}) {
  return (
    <div
      role="status"
      className={[
        "pointer-events-auto flex max-w-sm items-start gap-3 rounded-md px-4 py-3 text-sm text-white shadow-lg",
        KIND_STYLES[toast.kind],
      ].join(" ")}
      style={{ animation: "toast-in 180ms ease-out" }}
    >
      <span className="flex-1 break-words">{toast.message}</span>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="rounded text-white/80 hover:text-white"
      >
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  );
}
