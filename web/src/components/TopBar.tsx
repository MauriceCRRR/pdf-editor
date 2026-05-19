import { Download } from "lucide-react";
import { getPdfUrl } from "../lib/api";
import { useDocumentStore } from "../state/useDocumentStore";

export function TopBar() {
  const doc = useDocumentStore((s) => s.document);
  const reset = useDocumentStore((s) => s.reset);
  const editsSize = useDocumentStore((s) => s.edits.size);
  const insertionsSize = useDocumentStore((s) => s.insertions.size);
  const isSaving = useDocumentStore((s) => s.isSaving);
  const saveChanges = useDocumentStore((s) => s.saveChanges);

  const isDirty = editsSize + insertionsSize > 0;
  const saveDisabled = !isDirty || isSaving;

  const saveClass = saveDisabled
    ? "cursor-not-allowed rounded-md bg-gray-200 px-4 py-1.5 text-sm font-medium text-gray-500"
    : "rounded-md bg-red-500 px-4 py-1.5 text-sm font-medium text-white hover:bg-red-600";

  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b border-gray-200 bg-white px-4">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={reset}
          className="text-base font-semibold text-gray-900"
        >
          PDF Editor
        </button>
        {doc ? (
          <span className="truncate text-sm text-gray-500" title={doc.filename}>
            {doc.filename}
          </span>
        ) : null}
      </div>
      <div className="flex items-center gap-2">
        {doc ? (
          <a
            href={getPdfUrl(doc.documentId)}
            download={doc.filename}
            title="Download PDF"
            className="flex h-8 w-8 items-center justify-center rounded-md border border-gray-300 bg-white text-gray-700 hover:bg-gray-100"
          >
            <Download size={16} aria-hidden="true" />
          </a>
        ) : null}
        <button
          type="button"
          disabled={saveDisabled}
          onClick={() => {
            void saveChanges();
          }}
          className={saveClass}
        >
          {isSaving ? "Saving..." : "Save changes"}
        </button>
      </div>
    </header>
  );
}
