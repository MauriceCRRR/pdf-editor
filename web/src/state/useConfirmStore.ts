import { create } from "zustand";

export type Resolution = "save" | "discard" | "cancel";

type ConfirmState = {
  open: boolean;
  count: number;
  resolve: ((r: Resolution) => void) | null;
  ask: (count: number) => Promise<Resolution>;
  respond: (r: Resolution) => void;
};

export const useConfirmStore = create<ConfirmState>((set, get) => ({
  open: false,
  count: 0,
  resolve: null,
  ask: (count) => {
    if (get().open) return Promise.resolve<Resolution>("cancel");
    return new Promise<Resolution>((resolve) => {
      set({ open: true, count, resolve });
    });
  },
  respond: (r) => {
    const fn = get().resolve;
    set({ open: false, resolve: null });
    if (fn) fn(r);
  },
}));
