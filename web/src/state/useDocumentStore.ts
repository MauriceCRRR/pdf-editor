import { create } from "zustand";
import { temporal, type TemporalState } from "zundo";
import { useStore, type StoreApi } from "zustand";
import { shallow } from "zustand/shallow";
import {
  addPage as apiAddPage,
  deletePage as apiDeletePage,
  getDocument,
  getPdfUrl,
  reorderPages as apiReorderPages,
  saveDocument,
  streamUploadProgress,
  uploadPdf as apiUploadPdf,
  uploadPdfStreaming as apiUploadPdfStreaming,
  type DocumentMeta,
  type DocumentResponse,
  type Edit,
  type FontEntry,
  type InsertTool,
  type Insertion,
  type PageData,
  type UploadProgressEvent,
} from "../lib/api";
import { buildBaselineEdit, findFragmentById } from "../lib/edits";
import { registerFonts, unregisterFonts } from "../lib/fonts";
import { cMapPacked, cMapUrl, pdfjsLib, standardFontDataUrl, type PDFDocumentProxy } from "../lib/pdfjs";
import { useConfirmStore } from "./useConfirmStore";
import { useToastStore } from "./useToastStore";

export type DocStatus = "idle" | "uploading" | "loading" | "ready" | "error";

export type EditMode = "edit-text" | "insert" | null;

export type InsertModeState = { tool: InsertTool } | null;

type DocumentState = {
  document: DocumentMeta | null;
  pdf: PDFDocumentProxy | null;
  pages: PageData[];
  fonts: FontEntry[];
  subsetByRef: Map<string, string>;
  masterByRef: Map<string, string>;
  fontByRef: Map<string, FontEntry>;
  availableCodepointsByRef: Map<string, Set<number>>;
  loadedFaces: FontFace[];
  activeFragId: string | null;
  expandedFragments: Set<string>;
  pageCanvases: Map<number, HTMLCanvasElement>;
  renderVersions: Map<number, number>;
  status: DocStatus;
  error: string | null;
  editMode: EditMode;
  edits: Map<string, Edit>;
  insertions: Map<string, Insertion>;
  insertMode: InsertModeState;
  activeInsertionId: string | null;
  isSaving: boolean;
  currentUploadToken: number;
  uploadPdf: (file: File) => Promise<void>;
  uploadPdfStreaming: (
    file: File,
    onProgress?: (e: UploadProgressEvent) => void,
  ) => Promise<void>;
  setEditMode: (mode: EditMode) => void;
  setActiveFragId: (id: string | null) => void;
  registerCanvas: (pageIndex: number, canvas: HTMLCanvasElement) => void;
  unregisterCanvas: (pageIndex: number) => void;
  bumpRenderVersion: (pageIndex: number) => void;
  updateEdit: (fragId: string, partial: Partial<Edit>) => void;
  discardEdit: (fragId: string) => void;
  markFragmentExpanded: (fragId: string, expanded: boolean) => void;
  setInsertTool: (tool: InsertTool) => void;
  exitInsertMode: () => void;
  createInsertion: (insertion: Insertion) => void;
  updateInsertion: (id: string, partial: Partial<Insertion>) => void;
  discardInsertion: (id: string) => void;
  setActiveInsertionId: (id: string | null) => void;
  saveChanges: () => Promise<void>;
  addBlankPage: (atIndex: number) => Promise<void>;
  removePage: (index: number) => Promise<void>;
  reorderPages: (order: number[]) => Promise<void>;
  reset: () => void;
};

type PartializedState = {
  edits: Map<string, Edit>;
  insertions: Map<string, Insertion>;
  activeFragId: string | null;
  activeInsertionId: string | null;
};

function buildCodepointsByRef(fonts: FontEntry[]): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  for (const f of fonts) {
    out.set(f.ref, new Set(f.availableCodepoints));
  }
  return out;
}

function leadingDebounce<A extends unknown[]>(
  fn: (...args: A) => void,
  wait: number,
): (...args: A) => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: A | null = null;
  return (...args: A) => {
    if (timer === null) {
      fn(...args);
      pending = null;
    } else {
      pending = args;
    }
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (pending !== null) {
        const last = pending;
        pending = null;
        fn(...last);
      }
    }, wait);
  };
}

// Monotonic counter for upload re-entrancy: each uploadPdf call grabs a unique
// token. After every await boundary, the action checks that its token is still
// current and discards its result otherwise. saveChanges / addBlankPage /
// removePage / reorderPages do not need a token: they are gated by isSaving,
// so only one runs at a time per user action.
let uploadCounter = 0;

// Page-mutation dirty-check: if there are unsaved edits/insertions, ask the
// user whether to save, discard, or cancel before mutating the page list.
// Returns true if the caller should proceed with the mutation, false to abort.
async function confirmDirtyMutation(
  get: () => DocumentState,
): Promise<boolean> {
  const { edits, insertions } = get();
  const dirtyCount = edits.size + insertions.size;
  if (dirtyCount === 0) return true;
  const choice = await useConfirmStore.getState().ask(dirtyCount);
  if (choice === "cancel") return false;
  if (choice === "save") {
    await get().saveChanges();
    // If save failed, leave the dirty edits in place and abort the mutation
    // — surfacing the error toast that saveChanges already pushed.
    if (get().error || get().edits.size + get().insertions.size > 0) {
      return false;
    }
  }
  // "discard" — fall through; applyDocumentResponse will clear edits anyway.
  return true;
}

function editsShallowEqual(
  a: Map<string, Edit>,
  b: Map<string, Edit>,
): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const [k, v] of a) {
    const other = b.get(k);
    if (!other) return false;
    if (other === v) continue;
    if (!shallow(other, v)) return false;
  }
  return true;
}

function insertionsShallowEqual(
  a: Map<string, Insertion>,
  b: Map<string, Insertion>,
): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const [k, v] of a) {
    const other = b.get(k);
    if (!other) return false;
    if (other === v) continue;
    if (!shallow(other, v)) return false;
  }
  return true;
}

async function applyDocumentResponse(
  get: () => DocumentState,
  set: (partial: Partial<DocumentState>) => void,
  updated: DocumentResponse,
): Promise<void> {
  const { pdf: currentPdf, loadedFaces } = get();
  unregisterFonts(loadedFaces);
  const registered = await registerFonts(updated.documentId, updated.fonts);
  const fontByRef = new Map<string, FontEntry>();
  for (const f of updated.fonts) {
    fontByRef.set(f.ref, f);
  }
  const freshUrl = `${getPdfUrl(updated.documentId)}?t=${Date.now()}`;
  const newPdf = await pdfjsLib.getDocument({
    url: freshUrl,
    cMapUrl,
    cMapPacked,
    standardFontDataUrl,
  }).promise;
  if (currentPdf) {
    void currentPdf.destroy();
  }
  set({
    pdf: newPdf,
    pages: updated.pages,
    fonts: updated.fonts,
    subsetByRef: registered.subsetByRef,
    masterByRef: registered.masterByRef,
    fontByRef,
    availableCodepointsByRef: buildCodepointsByRef(updated.fonts),
    loadedFaces: registered.faces,
    document: {
      documentId: updated.documentId,
      filename: updated.filename,
      pageCount: updated.pageCount,
    },
    edits: new Map(),
    insertions: new Map(),
    activeInsertionId: null,
    expandedFragments: new Set(),
    activeFragId: null,
    isSaving: false,
  });
  useDocumentStore.temporal.getState().clear();
}

export const useDocumentStore = create<DocumentState>()(
  temporal(
    (set, get) => ({
      document: null,
      pdf: null,
      pages: [],
      fonts: [],
      subsetByRef: new Map(),
      masterByRef: new Map(),
      fontByRef: new Map(),
      availableCodepointsByRef: new Map(),
      loadedFaces: [],
      activeFragId: null,
      expandedFragments: new Set(),
      pageCanvases: new Map(),
      renderVersions: new Map(),
      status: "idle",
      error: null,
      editMode: null,
      edits: new Map(),
      insertions: new Map(),
      insertMode: null,
      activeInsertionId: null,
      isSaving: false,
      currentUploadToken: 0,
      async uploadPdf(file: File) {
        const myToken = ++uploadCounter;
        set({ status: "uploading", error: null, currentUploadToken: myToken });
        let createdPdf: PDFDocumentProxy | null = null;
        try {
          const meta = await apiUploadPdf(file);
          if (get().currentUploadToken !== myToken) return;
          set({
            document: { documentId: meta.documentId, filename: meta.filename, pageCount: meta.pageCount },
            status: "loading",
          });

          const url = `/api/doc/${encodeURIComponent(meta.documentId)}/pdf`;
          const loadingTask = pdfjsLib.getDocument({
            url,
            cMapUrl,
            cMapPacked,
            standardFontDataUrl,
          });
          const [pdf, docResponse] = await Promise.all([
            loadingTask.promise,
            getDocument(meta.documentId),
          ]);
          createdPdf = pdf;
          if (get().currentUploadToken !== myToken) {
            void pdf.destroy();
            return;
          }

          const registered = await registerFonts(docResponse.documentId, docResponse.fonts);
          if (get().currentUploadToken !== myToken) {
            void pdf.destroy();
            unregisterFonts(registered.faces);
            return;
          }
          const fontByRef = new Map<string, FontEntry>();
          for (const f of docResponse.fonts) {
            fontByRef.set(f.ref, f);
          }

          set({
            pdf,
            pages: docResponse.pages,
            fonts: docResponse.fonts,
            subsetByRef: registered.subsetByRef,
            masterByRef: registered.masterByRef,
            fontByRef,
            availableCodepointsByRef: buildCodepointsByRef(docResponse.fonts),
            loadedFaces: registered.faces,
            document: {
              documentId: docResponse.documentId,
              filename: docResponse.filename,
              pageCount: docResponse.pageCount,
            },
            status: "ready",
            editMode: "edit-text",
            edits: new Map(),
            insertions: new Map(),
            insertMode: null,
            activeInsertionId: null,
            expandedFragments: new Set(),
          });
          useDocumentStore.temporal.getState().clear();
        } catch (err) {
          if (get().currentUploadToken !== myToken) {
            if (createdPdf) void createdPdf.destroy();
            return;
          }
          const message = err instanceof Error ? err.message : "Unknown error";
          set({ status: "error", error: message });
          useToastStore.getState().pushToast({ kind: "error", message: `Upload failed: ${message}` });
        }
      },
      async uploadPdfStreaming(file: File, onProgress) {
        const myToken = ++uploadCounter;
        set({ status: "uploading", error: null, currentUploadToken: myToken });
        let createdPdf: PDFDocumentProxy | null = null;
        try {
          const { jobId, documentId } = await apiUploadPdfStreaming(file);
          if (get().currentUploadToken !== myToken) return;
          set({ document: { documentId, filename: file.name, pageCount: 0 } });

          // Wait for the SSE stream to signal "done" before fetching the
          // extracted document. Forward every event to the optional onProgress
          // callback so UploadZone can render a progress bar.
          await new Promise<void>((resolve, reject) => {
            let settled = false;
            streamUploadProgress(jobId, (evt) => {
              if (settled) return;
              onProgress?.(evt);
              if ("error" in evt) {
                settled = true;
                reject(new Error(evt.error));
                return;
              }
              if ("done" in evt) {
                settled = true;
                resolve();
              }
            });
          });
          if (get().currentUploadToken !== myToken) return;

          set({ status: "loading" });
          const url = `/api/doc/${encodeURIComponent(documentId)}/pdf`;
          const loadingTask = pdfjsLib.getDocument({
            url,
            cMapUrl,
            cMapPacked,
            standardFontDataUrl,
          });
          const [pdf, docResponse] = await Promise.all([
            loadingTask.promise,
            getDocument(documentId),
          ]);
          createdPdf = pdf;
          if (get().currentUploadToken !== myToken) {
            void pdf.destroy();
            return;
          }

          const registered = await registerFonts(docResponse.documentId, docResponse.fonts);
          if (get().currentUploadToken !== myToken) {
            void pdf.destroy();
            unregisterFonts(registered.faces);
            return;
          }
          const fontByRef = new Map<string, FontEntry>();
          for (const f of docResponse.fonts) {
            fontByRef.set(f.ref, f);
          }

          set({
            pdf,
            pages: docResponse.pages,
            fonts: docResponse.fonts,
            subsetByRef: registered.subsetByRef,
            masterByRef: registered.masterByRef,
            fontByRef,
            availableCodepointsByRef: buildCodepointsByRef(docResponse.fonts),
            loadedFaces: registered.faces,
            document: {
              documentId: docResponse.documentId,
              filename: docResponse.filename,
              pageCount: docResponse.pageCount,
            },
            status: "ready",
            editMode: "edit-text",
            edits: new Map(),
            insertions: new Map(),
            insertMode: null,
            activeInsertionId: null,
            expandedFragments: new Set(),
          });
          useDocumentStore.temporal.getState().clear();
        } catch (err) {
          if (get().currentUploadToken !== myToken) {
            if (createdPdf) void createdPdf.destroy();
            return;
          }
          const message = err instanceof Error ? err.message : "Unknown error";
          set({ status: "error", error: message });
          useToastStore.getState().pushToast({ kind: "error", message: `Upload failed: ${message}` });
        }
      },
      setEditMode(mode) {
        if (mode === "insert") {
          const current = get().insertMode;
          set({
            editMode: "insert",
            insertMode: current ?? { tool: "text" },
          });
          return;
        }
        set({
          editMode: mode,
          insertMode: null,
          activeInsertionId: mode === null ? null : get().activeInsertionId,
        });
      },
      setActiveFragId(id) {
        set({ activeFragId: id });
      },
      registerCanvas(pageIndex, canvas) {
        const next = new Map(get().pageCanvases);
        next.set(pageIndex, canvas);
        set({ pageCanvases: next });
      },
      unregisterCanvas(pageIndex) {
        const next = new Map(get().pageCanvases);
        next.delete(pageIndex);
        set({ pageCanvases: next });
      },
      bumpRenderVersion(pageIndex) {
        const current = get().renderVersions;
        const next = new Map(current);
        next.set(pageIndex, (current.get(pageIndex) ?? 0) + 1);
        set({ renderVersions: next });
      },
      updateEdit(fragId, partial) {
        const { pages, edits } = get();
        const existing = edits.get(fragId);
        let base: Edit;
        if (existing) {
          base = existing;
        } else {
          const found = findFragmentById(pages, fragId);
          if (!found) return;
          base = buildBaselineEdit(found.fragment, found.pageIndex);
        }
        const next = new Map(edits);
        const merged: Edit = {
          ...base,
          ...partial,
          fragId: base.fragId,
          pageIndex: base.pageIndex,
          originalBBox: base.originalBBox,
        };
        next.set(fragId, merged);
        set({ edits: next });
      },
      discardEdit(fragId) {
        const { edits } = get();
        if (!edits.has(fragId)) return;
        const next = new Map(edits);
        next.delete(fragId);
        set({ edits: next });
      },
      markFragmentExpanded(fragId, expanded) {
        const current = get().expandedFragments;
        const alreadyExpanded = current.has(fragId);
        if (expanded === alreadyExpanded) return;
        const next = new Set(current);
        if (expanded) {
          next.add(fragId);
        } else {
          next.delete(fragId);
        }
        set({ expandedFragments: next });
      },
      setInsertTool(tool) {
        set({
          editMode: "insert",
          insertMode: { tool },
          activeFragId: null,
        });
      },
      exitInsertMode() {
        set({
          editMode: "edit-text",
          insertMode: null,
          activeInsertionId: null,
        });
      },
      createInsertion(insertion) {
        const next = new Map(get().insertions);
        next.set(insertion.id, insertion);
        set({
          insertions: next,
          activeInsertionId: insertion.id,
          activeFragId: null,
        });
      },
      updateInsertion(id, partial) {
        const current = get().insertions;
        const existing = current.get(id);
        if (!existing) return;
        const next = new Map(current);
        const merged = { ...existing, ...partial, id: existing.id, type: existing.type } as Insertion;
        next.set(id, merged);
        set({ insertions: next });
      },
      discardInsertion(id) {
        const { insertions, activeInsertionId } = get();
        if (!insertions.has(id)) return;
        const next = new Map(insertions);
        next.delete(id);
        set({
          insertions: next,
          activeInsertionId: activeInsertionId === id ? null : activeInsertionId,
        });
      },
      setActiveInsertionId(id) {
        set({ activeInsertionId: id });
      },
      async saveChanges() {
        const { edits, insertions, isSaving, document: doc } = get();
        if ((edits.size === 0 && insertions.size === 0) || isSaving || !doc) return;
        set({ isSaving: true, error: null });
        try {
          const { document: updated, warnings } = await saveDocument(doc.documentId, {
            edits: [...edits.values()],
            insertions: [...insertions.values()],
          });
          await applyDocumentResponse(get, set, updated);
          useToastStore.getState().pushToast({ kind: "success", message: "Changes saved" });
          if (warnings.length > 0) {
            // eslint-disable-next-line no-console
            console.warn("[saveDocument] warnings:", warnings);
            for (const w of warnings) {
              useToastStore.getState().pushToast({
                kind: "info",
                message: w.message,
                duration: 5000,
              });
            }
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : "Save failed";
          set({ error: message, isSaving: false });
          useToastStore.getState().pushToast({ kind: "error", message: `Save failed: ${message}` });
        }
      },
      async addBlankPage(atIndex: number) {
        const { document: doc, isSaving } = get();
        if (!doc || isSaving) return;
        if (!(await confirmDirtyMutation(get))) return;
        if (get().isSaving) return;
        set({ isSaving: true, error: null });
        try {
          const updated = await apiAddPage(doc.documentId, atIndex);
          await applyDocumentResponse(get, set, updated);
        } catch (err) {
          const message = err instanceof Error ? err.message : "Add page failed";
          set({ error: message, isSaving: false });
          useToastStore.getState().pushToast({ kind: "error", message: `Add page failed: ${message}` });
        }
      },
      async removePage(index: number) {
        const { document: doc, isSaving } = get();
        if (!doc || isSaving) return;
        if (!(await confirmDirtyMutation(get))) return;
        if (get().isSaving) return;
        set({ isSaving: true, error: null });
        try {
          const updated = await apiDeletePage(doc.documentId, index);
          await applyDocumentResponse(get, set, updated);
        } catch (err) {
          const message = err instanceof Error ? err.message : "Delete page failed";
          set({ error: message, isSaving: false });
          useToastStore.getState().pushToast({ kind: "error", message: `Delete page failed: ${message}` });
        }
      },
      async reorderPages(order: number[]) {
        const { document: doc, isSaving } = get();
        if (!doc || isSaving) return;
        if (!(await confirmDirtyMutation(get))) return;
        if (get().isSaving) return;
        set({ isSaving: true, error: null });
        try {
          const updated = await apiReorderPages(doc.documentId, order);
          await applyDocumentResponse(get, set, updated);
        } catch (err) {
          const message = err instanceof Error ? err.message : "Reorder failed";
          set({ error: message, isSaving: false });
          useToastStore.getState().pushToast({ kind: "error", message: `Reorder failed: ${message}` });
        }
      },
      reset() {
        const { pdf, loadedFaces } = get();
        if (pdf) {
          void pdf.destroy();
        }
        unregisterFonts(loadedFaces);
        set({
          document: null,
          pdf: null,
          pages: [],
          fonts: [],
          subsetByRef: new Map(),
          masterByRef: new Map(),
          fontByRef: new Map(),
          availableCodepointsByRef: new Map(),
          loadedFaces: [],
          activeFragId: null,
          expandedFragments: new Set(),
          pageCanvases: new Map(),
          renderVersions: new Map(),
          status: "idle",
          error: null,
          editMode: null,
          edits: new Map(),
          insertions: new Map(),
          insertMode: null,
          activeInsertionId: null,
          isSaving: false,
          currentUploadToken: ++uploadCounter,
        });
        useDocumentStore.temporal.getState().clear();
      },
    }),
    {
      partialize: (state): PartializedState => ({
        edits: state.edits,
        insertions: state.insertions,
        activeFragId: state.activeFragId,
        activeInsertionId: state.activeInsertionId,
      }),
      equality: (a, b) =>
        a.activeFragId === b.activeFragId &&
        a.activeInsertionId === b.activeInsertionId &&
        editsShallowEqual(a.edits, b.edits) &&
        insertionsShallowEqual(a.insertions, b.insertions),
      handleSet: (handleSet) => leadingDebounce(handleSet, 400),
    },
  ),
);

export function useTemporalStore<T>(
  selector: (state: TemporalState<PartializedState>) => T,
): T {
  const temporalStore = useDocumentStore.temporal as StoreApi<
    TemporalState<PartializedState>
  >;
  return useStore(temporalStore, selector);
}
