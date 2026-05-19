import { create } from "zustand";

export type ToastKind = "success" | "error" | "info";

export type Toast = {
  id: string;
  kind: ToastKind;
  message: string;
  duration: number;
};

export type ToastInput = {
  kind: ToastKind;
  message: string;
  duration?: number;
};

const MAX_TOASTS = 5;
const DEFAULT_DURATION = 4000;

type ToastState = {
  toasts: Toast[];
  pushToast: (input: ToastInput) => string;
  dismissToast: (id: string) => void;
};

function makeId(): string {
  return `toast-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export const useToastStore = create<ToastState>((set, get) => ({
  toasts: [],
  pushToast({ kind, message, duration }) {
    const id = makeId();
    const ms = duration ?? DEFAULT_DURATION;
    const toast: Toast = { id, kind, message, duration: ms };
    const next = [...get().toasts, toast].slice(-MAX_TOASTS);
    set({ toasts: next });
    if (ms > 0) {
      window.setTimeout(() => {
        get().dismissToast(id);
      }, ms);
    }
    return id;
  },
  dismissToast(id) {
    set({ toasts: get().toasts.filter((t) => t.id !== id) });
  },
}));
