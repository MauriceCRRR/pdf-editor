import { useCallback, useRef, useState } from "react";
import type { UploadProgressEvent } from "../lib/api";
import { useDocumentStore } from "../state/useDocumentStore";
import { useToastStore } from "../state/useToastStore";

const MAX_FILE_BYTES = 50 * 1024 * 1024;
// Files larger than this hit the SSE streaming endpoint so the user sees
// per-page progress instead of a generic spinner.
const STREAMING_THRESHOLD_BYTES = 5 * 1024 * 1024;

export function UploadZone() {
  const status = useDocumentStore((s) => s.status);
  const error = useDocumentStore((s) => s.error);
  const upload = useDocumentStore((s) => s.uploadPdf);
  const uploadStreaming = useDocumentStore((s) => s.uploadPdfStreaming);
  const [dragOver, setDragOver] = useState(false);
  const [clientError, setClientError] = useState<string | null>(null);
  const [pct, setPct] = useState<number | null>(null);
  const [phase, setPhase] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleProgress = useCallback((evt: UploadProgressEvent) => {
    if ("error" in evt) {
      setPct(null);
      setPhase(null);
      return;
    }
    if ("done" in evt) {
      setPct(100);
      setPhase("Loading document...");
      return;
    }
    const ratio = evt.total > 0 ? evt.done / evt.total : 0;
    setPct(Math.round(ratio * 100));
    setPhase(
      evt.phase === "fonts"
        ? "Extracting fonts..."
        : `Page ${evt.done} of ${evt.total}`,
    );
  }, []);

  const onFile = useCallback(
    (file: File | undefined) => {
      if (!file) return;
      const isPdf =
        file.type === "application/pdf" ||
        file.name.toLowerCase().endsWith(".pdf");
      if (!isPdf) {
        const msg = "Only PDF files supported";
        setClientError(msg);
        useToastStore.getState().pushToast({ kind: "error", message: msg });
        return;
      }
      if (file.size > MAX_FILE_BYTES) {
        const msg = "File too large (max 50 MB)";
        setClientError(msg);
        useToastStore.getState().pushToast({ kind: "error", message: msg });
        return;
      }
      setClientError(null);
      if (file.size > STREAMING_THRESHOLD_BYTES) {
        setPct(0);
        setPhase("Uploading...");
        void uploadStreaming(file, handleProgress).finally(() => {
          setPct(null);
          setPhase(null);
        });
      } else {
        void upload(file);
      }
    },
    [upload, uploadStreaming, handleProgress],
  );

  const onDrop = useCallback(
    (e: React.DragEvent<HTMLLabelElement>) => {
      e.preventDefault();
      setDragOver(false);
      onFile(e.dataTransfer.files?.[0]);
    },
    [onFile],
  );

  const busy = status === "uploading" || status === "loading";
  const showProgress = pct !== null;

  return (
    <div className="flex h-full w-full items-center justify-center bg-gray-50 p-8">
      <label
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        className={[
          "flex w-full max-w-2xl cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed bg-white px-10 py-20 text-center transition-colors",
          dragOver
            ? "border-gray-900 bg-gray-100"
            : "border-gray-300 hover:border-gray-500",
        ].join(" ")}
      >
        <input
          ref={inputRef}
          type="file"
          accept="application/pdf,.pdf"
          className="hidden"
          onChange={(e) => onFile(e.target.files?.[0])}
          disabled={busy}
        />
        <div className="mb-4 text-5xl text-gray-400">PDF</div>
        <h2 className="mb-2 text-2xl font-medium text-gray-900">
          {busy ? "Loading..." : "Select a PDF to edit"}
        </h2>
        <p className="mb-6 text-sm text-gray-500">
          Drop a PDF here, or click to choose a file
        </p>
        {clientError ? (
          <p className="mb-4 max-w-md text-sm text-red-600">{clientError}</p>
        ) : error ? (
          <p className="mb-4 max-w-md text-sm text-red-600">{error}</p>
        ) : null}
        <span className="rounded-md bg-gray-900 px-5 py-2 text-sm font-medium text-white">
          {busy ? "Please wait..." : "Choose file"}
        </span>
        {showProgress ? (
          <div className="mt-4 flex flex-col items-center gap-2">
            <progress max={100} value={pct ?? 0} className="h-2 w-64" />
            <div className="text-xs text-gray-600">
              {phase ?? ""} {pct ?? 0}%
            </div>
          </div>
        ) : null}
      </label>
    </div>
  );
}
