import {
  ArrowUpRight,
  Circle,
  Image as ImageIcon,
  Slash,
  Square,
  Type,
} from "lucide-react";
import type { InsertTool } from "../lib/api";
import { useDocumentStore } from "../state/useDocumentStore";

type Tab = {
  id: "annotate" | "shapes" | "insert" | "edit-text" | "forms";
  label: string;
};

const TABS: Tab[] = [
  { id: "annotate", label: "Annotate" },
  { id: "shapes", label: "Shapes" },
  { id: "insert", label: "Insert" },
  { id: "edit-text", label: "Edit Text" },
  { id: "forms", label: "Forms" },
];

type InsertSubTool = {
  id: InsertTool;
  label: string;
  icon: () => React.ReactNode;
};

const INSERT_TOOLS: InsertSubTool[] = [
  { id: "text", label: "Text", icon: () => <Type size={16} aria-hidden="true" /> },
  { id: "rectangle", label: "Rectangle", icon: () => <Square size={16} aria-hidden="true" /> },
  { id: "ellipse", label: "Ellipse", icon: () => <Circle size={16} aria-hidden="true" /> },
  { id: "line", label: "Line", icon: () => <Slash size={16} aria-hidden="true" /> },
  { id: "arrow", label: "Arrow", icon: () => <ArrowUpRight size={16} aria-hidden="true" /> },
  { id: "image", label: "Image", icon: () => <ImageIcon size={16} aria-hidden="true" /> },
];

export function ModeToolbar() {
  const editMode = useDocumentStore((s) => s.editMode);
  const insertMode = useDocumentStore((s) => s.insertMode);
  const setEditMode = useDocumentStore((s) => s.setEditMode);
  const setInsertTool = useDocumentStore((s) => s.setInsertTool);

  const showInsertSubBar = editMode === "insert";

  return (
    <div className="flex flex-col">
      <nav className="flex h-12 shrink-0 items-center gap-1 border-b border-gray-200 bg-white px-4">
        {TABS.map((tab) => {
          const isInteractive = tab.id === "edit-text" || tab.id === "insert";
          const isActive =
            (tab.id === "edit-text" && editMode === "edit-text") ||
            (tab.id === "insert" && editMode === "insert");

          if (!isInteractive) {
            const disabledTitle =
              tab.id === "forms" ? "Phase 2 — coming soon" : undefined;
            return (
              <span
                key={tab.id}
                aria-disabled="true"
                title={disabledTitle}
                className="cursor-not-allowed select-none px-4 py-3 text-sm font-medium text-gray-300"
              >
                {tab.label}
              </span>
            );
          }

          return (
            <button
              key={tab.id}
              type="button"
              aria-pressed={isActive}
              aria-label={`${tab.label} mode`}
              onClick={() => {
                if (tab.id === "insert") {
                  setEditMode("insert");
                } else {
                  setEditMode("edit-text");
                }
              }}
              className={[
                "relative select-none px-4 py-3 text-sm font-medium transition-colors",
                isActive ? "text-red-600" : "text-gray-700 hover:text-gray-900",
              ].join(" ")}
            >
              {tab.label}
              {isActive ? (
                <span className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-red-600" />
              ) : null}
            </button>
          );
        })}
      </nav>
      {showInsertSubBar ? (
        <nav className="flex h-12 shrink-0 items-center gap-2 border-b border-gray-200 bg-gray-50 px-4">
          {INSERT_TOOLS.map((tool) => {
            const active = insertMode?.tool === tool.id;
            return (
              <button
                key={tool.id}
                type="button"
                onClick={() => setInsertTool(tool.id)}
                className={[
                  "relative flex items-center gap-1.5 select-none px-3 py-2 text-sm font-medium transition-colors",
                  active ? "text-red-600" : "text-gray-700 hover:text-gray-900",
                ].join(" ")}
              >
                <span aria-hidden="true">{tool.icon()}</span>
                <span>{tool.label}</span>
                {active ? (
                  <span className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-red-600" />
                ) : null}
              </button>
            );
          })}
        </nav>
      ) : null}
    </div>
  );
}

