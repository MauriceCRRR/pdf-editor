import { useMemo, useRef, useState } from "react";
import {
  AlignCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  Redo2,
  Undo2,
} from "lucide-react";
import type {
  Align,
  Fragment,
  ImageInsertion,
  Insertion,
  LineInsertion,
  ShapeInsertion,
  TextInsertion,
} from "../lib/api";
import { uploadImage } from "../lib/api";
import { getEffectiveStyle } from "../lib/edits";
import {
  FONT_OPTIONS,
  familyLabelForFontKey,
  fontKeyFor,
  rgb01ToRgb255,
} from "../lib/insertions";
import { useDocumentStore, useTemporalStore } from "../state/useDocumentStore";
import { ColorPicker } from "./ColorPicker";

export function Sidebar() {
  const editMode = useDocumentStore((s) => s.editMode);
  const insertMode = useDocumentStore((s) => s.insertMode);
  const activeFragId = useDocumentStore((s) => s.activeFragId);
  const activeInsertionId = useDocumentStore((s) => s.activeInsertionId);
  const pages = useDocumentStore((s) => s.pages);
  const fontByRef = useDocumentStore((s) => s.fontByRef);
  const edits = useDocumentStore((s) => s.edits);
  const insertions = useDocumentStore((s) => s.insertions);
  const updateEdit = useDocumentStore((s) => s.updateEdit);
  const updateInsertion = useDocumentStore((s) => s.updateInsertion);

  const canUndo = useTemporalStore((s) => s.pastStates.length > 0);
  const canRedo = useTemporalStore((s) => s.futureStates.length > 0);

  const activeFragment = useMemo<Fragment | null>(() => {
    if (!activeFragId) return null;
    for (const page of pages) {
      const frag = page.fragments.find((f) => f.id === activeFragId);
      if (frag) return frag;
    }
    return null;
  }, [activeFragId, pages]);

  const activeInsertion = useMemo<Insertion | null>(() => {
    if (!activeInsertionId) return null;
    return insertions.get(activeInsertionId) ?? null;
  }, [activeInsertionId, insertions]);

  const onUndo = () => {
    if (!canUndo) return;
    useDocumentStore.temporal.getState().undo();
  };
  const onRedo = () => {
    if (!canRedo) return;
    useDocumentStore.temporal.getState().redo();
  };

  if (editMode === "insert" && activeInsertion === null) {
    const toolLabel = insertMode?.tool ?? "shape";
    return (
      <aside className="w-72 shrink-0 border-l border-gray-200 bg-white p-4">
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-400">
          Insert
        </h3>
        <p className="text-sm text-gray-500">
          Click and drag on the page to create a {toolLabel}.
        </p>
        <div className="mt-4 flex items-center gap-2">
          <UndoRedoButton onClick={onUndo} disabled={!canUndo} title="Undo">
            <Undo2 size={16} aria-hidden="true" />
          </UndoRedoButton>
          <UndoRedoButton onClick={onRedo} disabled={!canRedo} title="Redo">
            <Redo2 size={16} aria-hidden="true" />
          </UndoRedoButton>
        </div>
      </aside>
    );
  }

  if (activeInsertion !== null) {
    return (
      <aside className="w-72 shrink-0 overflow-y-auto border-l border-gray-200 bg-white p-4">
        <InsertionControls insertion={activeInsertion} updateInsertion={updateInsertion} />
        <div className="mt-4 flex items-center gap-2">
          <UndoRedoButton onClick={onUndo} disabled={!canUndo} title="Undo">
            <Undo2 size={16} aria-hidden="true" />
          </UndoRedoButton>
          <UndoRedoButton onClick={onRedo} disabled={!canRedo} title="Redo">
            <Redo2 size={16} aria-hidden="true" />
          </UndoRedoButton>
        </div>
      </aside>
    );
  }

  if (!activeFragment) {
    return (
      <aside className="w-72 shrink-0 border-l border-gray-200 bg-white p-4">
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-400">
          Tools
        </h3>
        <p className="text-sm text-gray-400">
          Select a text fragment to edit
        </p>
        <div className="mt-4 flex items-center gap-2">
          <UndoRedoButton onClick={onUndo} disabled={!canUndo} title="Undo">
            <Undo2 size={16} aria-hidden="true" />
          </UndoRedoButton>
          <UndoRedoButton onClick={onRedo} disabled={!canRedo} title="Redo">
            <Redo2 size={16} aria-hidden="true" />
          </UndoRedoButton>
        </div>
      </aside>
    );
  }

  const edit = edits.get(activeFragment.id);
  const effective = getEffectiveStyle(activeFragment, edit);
  const span = activeFragment.spans[0];
  const fontEntry = span?.fontRef ? fontByRef.get(span.fontRef) ?? null : null;
  const fontLabel = fontEntry?.baseName ?? span?.fontPsName ?? "Unknown";

  const setStyle = (partial: Parameters<typeof updateEdit>[1]) => {
    updateEdit(activeFragment.id, partial);
  };

  return (
    <aside className="w-72 shrink-0 overflow-y-auto border-l border-gray-200 bg-white p-4">
      <h3 className="mb-3 text-sm font-semibold text-gray-900">Text Styles</h3>

      <div className="mb-3 grid grid-cols-[1fr_5rem] gap-2">
        <input
          type="text"
          value={fontLabel}
          readOnly
          className="w-full rounded-md border border-gray-300 bg-gray-50 px-2 py-1.5 text-sm text-gray-800"
        />
        <SizeInput
          value={effective.size}
          onCommit={(n) => setStyle({ size: n })}
        />
      </div>

      <div className="mb-3 grid grid-cols-4 gap-2">
        <StyleToggle
          label="B"
          active={effective.bold}
          bold
          onClick={() => setStyle({ bold: !effective.bold })}
        />
        <StyleToggle
          label="I"
          active={effective.italic}
          italic
          onClick={() => setStyle({ italic: !effective.italic })}
        />
        <StyleToggle
          label="U"
          active={effective.underline}
          underline
          onClick={() => setStyle({ underline: !effective.underline })}
        />
        <StyleToggle
          label="S"
          active={effective.strikethrough}
          strike
          onClick={() => setStyle({ strikethrough: !effective.strikethrough })}
        />
      </div>

      <div className="mb-3 grid grid-cols-4 gap-2">
        {(["left", "center", "right", "justify"] as Align[]).map((align) => (
          <AlignButton
            key={align}
            active={effective.align === align}
            title={`Align ${align}`}
            onClick={() => setStyle({ align })}
          >
            <AlignIcon kind={align} />
          </AlignButton>
        ))}
      </div>

      <div className="mb-4">
        <button
          type="button"
          disabled
          className="flex w-full cursor-not-allowed items-center gap-2 rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-400"
          title="Link (coming soon)"
        >
          <span className="inline-block h-4 w-4 rounded-sm border border-gray-300" />
          Link
        </button>
      </div>

      <div className="mb-4">
        <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
          Current Color
        </h4>
        <div className="flex items-center gap-3">
          <ColorPicker
            color={effective.colorRgb}
            onChange={(rgb) => setStyle({ colorRgb: rgb })}
          />
          <span className="text-xs text-gray-500">
            rgb({Math.round(effective.colorRgb[0] * 255)},{" "}
            {Math.round(effective.colorRgb[1] * 255)},{" "}
            {Math.round(effective.colorRgb[2] * 255)})
          </span>
        </div>
      </div>

      <div className="mb-4">
        <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
          Custom Colors
        </h4>
        <ColorPicker
          color={effective.colorRgb}
          onChange={(rgb) => setStyle({ colorRgb: rgb })}
        />
      </div>

      <div className="flex items-center gap-2">
        <UndoRedoButton onClick={onUndo} disabled={!canUndo} title="Undo">
          <Undo2 size={16} aria-hidden="true" />
        </UndoRedoButton>
        <UndoRedoButton onClick={onRedo} disabled={!canRedo} title="Redo">
          <Redo2 size={16} aria-hidden="true" />
        </UndoRedoButton>
      </div>
    </aside>
  );
}

function InsertionControls({
  insertion,
  updateInsertion,
}: {
  insertion: Insertion;
  updateInsertion: (id: string, partial: Partial<Insertion>) => void;
}) {
  switch (insertion.type) {
    case "text":
      return <TextInsertionControls insertion={insertion} updateInsertion={updateInsertion} />;
    case "rectangle":
    case "ellipse":
      return <ShapeInsertionControls insertion={insertion} updateInsertion={updateInsertion} />;
    case "line":
    case "arrow":
      return <LineInsertionControls insertion={insertion} updateInsertion={updateInsertion} />;
    case "image":
      return <ImageInsertionControls insertion={insertion} updateInsertion={updateInsertion} />;
  }
}

function TextInsertionControls({
  insertion,
  updateInsertion,
}: {
  insertion: TextInsertion;
  updateInsertion: (id: string, partial: Partial<Insertion>) => void;
}) {
  const familyLabel = familyLabelForFontKey(insertion.fontKey);
  const colorRgb255 = rgb01ToRgb255(insertion.colorRgb);
  const set = (partial: Partial<TextInsertion>) => updateInsertion(insertion.id, partial);
  return (
    <div>
      <h3 className="mb-3 text-sm font-semibold text-gray-900">Text Box</h3>
      <div className="mb-3 grid grid-cols-[1fr_5rem] gap-2">
        <select
          value={familyLabel}
          onChange={(e) => {
            const family = FONT_OPTIONS.find((f) => f.label === e.target.value);
            if (!family) return;
            const next = fontKeyFor(family.regular, insertion.bold, insertion.italic);
            set({ fontKey: next });
          }}
          className="w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm text-gray-800 focus:outline-none focus:ring-1 focus:ring-gray-900"
        >
          {FONT_OPTIONS.map((f) => (
            <option key={f.label} value={f.label}>
              {f.label}
            </option>
          ))}
        </select>
        <SizeInput
          value={insertion.size}
          onCommit={(n) => set({ size: n })}
        />
      </div>
      <div className="mb-3 grid grid-cols-4 gap-2">
        <StyleToggle
          label="B"
          active={insertion.bold}
          bold
          onClick={() => {
            const bold = !insertion.bold;
            set({ bold, fontKey: fontKeyFor(insertion.fontKey, bold, insertion.italic) });
          }}
        />
        <StyleToggle
          label="I"
          active={insertion.italic}
          italic
          onClick={() => {
            const italic = !insertion.italic;
            set({ italic, fontKey: fontKeyFor(insertion.fontKey, insertion.bold, italic) });
          }}
        />
        <StyleToggle
          label="U"
          active={insertion.underline}
          underline
          onClick={() => set({ underline: !insertion.underline })}
        />
        <StyleToggle
          label="S"
          active={insertion.strikethrough}
          strike
          onClick={() => set({ strikethrough: !insertion.strikethrough })}
        />
      </div>
      <div className="mb-3 grid grid-cols-4 gap-2">
        {(["left", "center", "right", "justify"] as Align[]).map((align) => (
          <AlignButton
            key={align}
            active={insertion.align === align}
            title={`Align ${align}`}
            onClick={() => set({ align })}
          >
            <AlignIcon kind={align} />
          </AlignButton>
        ))}
      </div>
      <div className="mb-4">
        <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
          Color
        </h4>
        <div className="flex items-center gap-3">
          <ColorPicker
            color={insertion.colorRgb}
            onChange={(rgb) => set({ colorRgb: rgb })}
          />
          <span className="text-xs text-gray-500">
            rgb({colorRgb255[0]}, {colorRgb255[1]}, {colorRgb255[2]})
          </span>
        </div>
      </div>
    </div>
  );
}

function ShapeInsertionControls({
  insertion,
  updateInsertion,
}: {
  insertion: ShapeInsertion;
  updateInsertion: (id: string, partial: Partial<Insertion>) => void;
}) {
  const set = (partial: Partial<ShapeInsertion>) => updateInsertion(insertion.id, partial);
  const label = insertion.type === "rectangle" ? "Rectangle" : "Ellipse";
  return (
    <div>
      <h3 className="mb-3 text-sm font-semibold text-gray-900">{label}</h3>
      <div className="mb-4">
        <div className="mb-2 flex items-center justify-between">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500">
            Stroke
          </h4>
          <NoneToggle
            none={insertion.strokeRgb === null}
            onChange={(none) => set({ strokeRgb: none ? null : [0, 0, 0] })}
          />
        </div>
        {insertion.strokeRgb ? (
          <ColorPicker
            color={insertion.strokeRgb}
            onChange={(rgb) => set({ strokeRgb: rgb })}
          />
        ) : null}
      </div>
      <div className="mb-4">
        <div className="mb-2 flex items-center justify-between">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500">
            Fill
          </h4>
          <NoneToggle
            none={insertion.fillRgb === null}
            onChange={(none) => set({ fillRgb: none ? null : [1, 1, 1] })}
          />
        </div>
        {insertion.fillRgb ? (
          <ColorPicker
            color={insertion.fillRgb}
            onChange={(rgb) => set({ fillRgb: rgb })}
          />
        ) : null}
      </div>
      <div className="mb-4">
        <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
          Stroke width: {insertion.strokeWidth.toFixed(1)}pt
        </h4>
        <input
          type="range"
          min={0}
          max={8}
          step={0.5}
          value={insertion.strokeWidth}
          onChange={(e) => set({ strokeWidth: parseFloat(e.target.value) })}
          className="w-full"
        />
      </div>
    </div>
  );
}

function LineInsertionControls({
  insertion,
  updateInsertion,
}: {
  insertion: LineInsertion;
  updateInsertion: (id: string, partial: Partial<Insertion>) => void;
}) {
  const set = (partial: Partial<LineInsertion>) => updateInsertion(insertion.id, partial);
  const label = insertion.type === "arrow" ? "Arrow" : "Line";
  return (
    <div>
      <h3 className="mb-3 text-sm font-semibold text-gray-900">{label}</h3>
      <div className="mb-4">
        <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
          Color
        </h4>
        <ColorPicker
          color={insertion.strokeRgb}
          onChange={(rgb) => set({ strokeRgb: rgb })}
        />
      </div>
      <div className="mb-4">
        <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
          Stroke width: {insertion.strokeWidth.toFixed(1)}pt
        </h4>
        <input
          type="range"
          min={0.5}
          max={8}
          step={0.5}
          value={insertion.strokeWidth}
          onChange={(e) => set({ strokeWidth: parseFloat(e.target.value) })}
          className="w-full"
        />
      </div>
      {insertion.type === "arrow" ? (
        <button
          type="button"
          onClick={() => set({ fromPt: insertion.toPt, toPt: insertion.fromPt })}
          className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
        >
          Swap arrow direction
        </button>
      ) : null}
    </div>
  );
}

function ImageInsertionControls({
  insertion,
  updateInsertion,
}: {
  insertion: ImageInsertion;
  updateInsertion: (id: string, partial: Partial<Insertion>) => void;
}) {
  const documentId = useDocumentStore((s) => s.document?.documentId ?? null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  const onFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !documentId) return;
    setBusy(true);
    try {
      const uploaded = await uploadImage(documentId, file);
      updateInsertion(insertion.id, { imageRef: uploaded.imageRef });
    } catch (err) {
      console.error("[image replace] failed:", err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <h3 className="mb-3 text-sm font-semibold text-gray-900">Image</h3>
      <button
        type="button"
        disabled={busy}
        onClick={() => fileInputRef.current?.click()}
        className={[
          "w-full rounded-md border px-3 py-2 text-sm",
          busy
            ? "cursor-not-allowed border-gray-200 bg-gray-50 text-gray-400"
            : "border-gray-300 bg-white text-gray-700 hover:bg-gray-50",
        ].join(" ")}
      >
        {busy ? "Uploading..." : "Replace image"}
      </button>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        hidden
        onChange={onFileChange}
      />
      <p className="mt-3 text-xs text-gray-400">
        Fit to page and reset aspect ratio coming soon.
      </p>
    </div>
  );
}

function NoneToggle({
  none,
  onChange,
}: {
  none: boolean;
  onChange: (none: boolean) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!none)}
      className={[
        "rounded-md border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
        none
          ? "border-gray-900 bg-gray-900 text-white"
          : "border-gray-300 bg-white text-gray-600 hover:bg-gray-50",
      ].join(" ")}
    >
      None
    </button>
  );
}

function SizeInput({
  value,
  onCommit,
}: {
  value: number;
  onCommit: (n: number) => void;
}) {
  return (
    <SizeInputInner key={value.toFixed(4)} value={value} onCommit={onCommit} />
  );
}

function SizeInputInner({
  value,
  onCommit,
}: {
  value: number;
  onCommit: (n: number) => void;
}) {
  const [draft, setDraft] = useState(value.toFixed(2));

  const commit = () => {
    const n = parseFloat(draft);
    if (Number.isFinite(n)) {
      const clamped = Math.max(4, Math.min(144, n));
      onCommit(clamped);
      setDraft(clamped.toFixed(2));
    } else {
      setDraft(value.toFixed(2));
    }
  };

  return (
    <input
      type="text"
      inputMode="decimal"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          (e.currentTarget as HTMLInputElement).blur();
        }
      }}
      className="w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-right text-sm text-gray-800 focus:outline-none focus:ring-1 focus:ring-gray-900"
    />
  );
}

function StyleToggle({
  label,
  active,
  bold,
  italic,
  underline,
  strike,
  onClick,
}: {
  label: string;
  active: boolean;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={[
        "flex h-9 w-full items-center justify-center rounded-md border text-sm",
        active
          ? "border-gray-900 bg-gray-900 text-white"
          : "border-gray-300 bg-white text-gray-700 hover:bg-gray-50",
        bold ? "font-bold" : "",
        italic ? "italic" : "",
        underline ? "underline" : "",
        strike ? "line-through" : "",
      ].join(" ")}
    >
      {label}
    </button>
  );
}

function AlignButton({
  title,
  active,
  onClick,
  children,
}: {
  title: string;
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      title={title}
      className={[
        "flex h-9 w-full items-center justify-center rounded-md border",
        active
          ? "border-gray-900 bg-gray-900 text-white"
          : "border-gray-300 bg-white text-gray-700 hover:bg-gray-50",
      ].join(" ")}
    >
      {children}
    </button>
  );
}

function UndoRedoButton({
  onClick,
  disabled,
  title,
  children,
}: {
  onClick: () => void;
  disabled: boolean;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={[
        "flex h-8 w-8 items-center justify-center rounded-md border",
        disabled
          ? "cursor-not-allowed border-gray-200 bg-gray-50 text-gray-400"
          : "border-gray-300 bg-white text-gray-700 hover:bg-gray-50",
      ].join(" ")}
    >
      {children}
    </button>
  );
}

function AlignIcon({ kind }: { kind: "left" | "center" | "right" | "justify" }) {
  switch (kind) {
    case "left":
      return <AlignLeft size={16} aria-hidden="true" />;
    case "center":
      return <AlignCenter size={16} aria-hidden="true" />;
    case "right":
      return <AlignRight size={16} aria-hidden="true" />;
    case "justify":
      return <AlignJustify size={16} aria-hidden="true" />;
  }
}

