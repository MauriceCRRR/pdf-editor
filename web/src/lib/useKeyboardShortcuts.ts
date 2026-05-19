import { useEffect } from "react";
import { useDocumentStore } from "../state/useDocumentStore";

function isMac(): boolean {
  if (typeof navigator === "undefined") return false;
  const platform = navigator.platform ?? "";
  return platform.toLowerCase().includes("mac");
}

function isModifier(e: KeyboardEvent): boolean {
  return isMac() ? e.metaKey : e.ctrlKey;
}

function isInContentEditable(): boolean {
  const el = document.activeElement;
  if (!el) return false;
  if (el instanceof HTMLInputElement) return true;
  if (el instanceof HTMLTextAreaElement) return true;
  const html = el as HTMLElement;
  if (typeof html.isContentEditable === "boolean" && html.isContentEditable) {
    return true;
  }
  return false;
}

function toggleActiveStyle(
  prop: "bold" | "italic" | "underline",
): void {
  const state = useDocumentStore.getState();
  const { activeFragId, activeInsertionId, edits, pages, insertions } = state;
  if (activeFragId) {
    const fragment = pages
      .flatMap((p) => p.fragments)
      .find((f) => f.id === activeFragId);
    if (!fragment) return;
    const existing = edits.get(activeFragId);
    const baseSpan = fragment.spans[0];
    const current =
      existing?.[prop] ??
      (prop === "underline"
        ? false
        : prop === "italic"
          ? baseSpan?.italic ?? false
          : baseSpan?.bold ?? false);
    state.updateEdit(activeFragId, { [prop]: !current });
    return;
  }
  if (activeInsertionId) {
    const insertion = insertions.get(activeInsertionId);
    if (!insertion || insertion.type !== "text") return;
    const next = !insertion[prop];
    state.updateInsertion(activeInsertionId, { [prop]: next });
  }
}

export function useKeyboardShortcuts(): void {
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      const mod = isModifier(e);
      const key = e.key;
      const lower = key.length === 1 ? key.toLowerCase() : key;

      if (mod && lower === "s") {
        e.preventDefault();
        e.stopPropagation();
        void useDocumentStore.getState().saveChanges();
        return;
      }

      if (mod && lower === "z" && !e.shiftKey) {
        if (isInContentEditable()) return;
        e.preventDefault();
        useDocumentStore.temporal.getState().undo();
        return;
      }

      if (mod && ((lower === "z" && e.shiftKey) || lower === "y")) {
        if (isInContentEditable()) return;
        e.preventDefault();
        useDocumentStore.temporal.getState().redo();
        return;
      }

      if (mod && lower === "b") {
        if (isInContentEditable()) return;
        e.preventDefault();
        toggleActiveStyle("bold");
        return;
      }
      if (mod && lower === "i") {
        if (isInContentEditable()) return;
        e.preventDefault();
        toggleActiveStyle("italic");
        return;
      }
      if (mod && lower === "u") {
        if (isInContentEditable()) return;
        e.preventDefault();
        toggleActiveStyle("underline");
        return;
      }

      if (key === "Escape") {
        const state = useDocumentStore.getState();
        const { activeFragId, activeInsertionId, editMode } = state;
        if (activeFragId || activeInsertionId) {
          state.setActiveFragId(null);
          state.setActiveInsertionId(null);
        }
        if (editMode === "insert") {
          state.exitInsertMode();
        }
        return;
      }

      if (key === "Delete" || key === "Backspace") {
        if (isInContentEditable()) return;
        const state = useDocumentStore.getState();
        const { activeInsertionId } = state;
        if (activeInsertionId) {
          e.preventDefault();
          state.discardInsertion(activeInsertionId);
        }
      }
    };

    document.addEventListener("keydown", handler, { capture: true });
    return () => {
      document.removeEventListener("keydown", handler, { capture: true });
    };
  }, []);
}
