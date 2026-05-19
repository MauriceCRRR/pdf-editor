import { useEffect } from "react";
import { Loader2 } from "lucide-react";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { ModeToolbar } from "./components/ModeToolbar";
import { PageStack } from "./components/PageStack";
import { Sidebar } from "./components/Sidebar";
import { ThumbnailRail } from "./components/ThumbnailRail";
import { ToastViewport } from "./components/Toast";
import { TopBar } from "./components/TopBar";
import { UploadZone } from "./components/UploadZone";
import { assertCriticalSupport } from "./lib/browserSupport";
import { useKeyboardShortcuts } from "./lib/useKeyboardShortcuts";
import { useDocumentStore } from "./state/useDocumentStore";
import { useToastStore } from "./state/useToastStore";

function App() {
  useKeyboardShortcuts();

  useEffect(() => {
    const missing = assertCriticalSupport();
    if (missing.length > 0) {
      useToastStore.getState().pushToast({
        kind: "error",
        message: `Your browser is missing required features: ${missing.join(", ")}. Editing may not work correctly.`,
        duration: 0,
      });
    }
  }, []);

  const pdf = useDocumentStore((s) => s.pdf);
  const pages = useDocumentStore((s) => s.pages);
  const status = useDocumentStore((s) => s.status);
  const isSaving = useDocumentStore((s) => s.isSaving);

  const hasDoc = pdf !== null && status === "ready";
  const showUploadOverlay = status === "uploading" || status === "loading";
  const showSaveOverlay = isSaving;

  return (
    <ErrorBoundary>
      <div className="flex h-full w-full flex-col bg-white text-gray-900">
        <TopBar />
        {hasDoc ? <ModeToolbar /> : null}
        <div className="relative flex min-h-0 flex-1">
          {hasDoc ? (
            <>
              <ThumbnailRail pdf={pdf} pages={pages} />
              <PageStack pdf={pdf} pages={pages} />
              <Sidebar />
              {showSaveOverlay ? (
                <LoadingOverlay label="Saving changes..." />
              ) : null}
            </>
          ) : (
            <>
              <UploadZone />
              {showUploadOverlay ? (
                <LoadingOverlay label="Uploading PDF..." />
              ) : null}
            </>
          )}
        </div>
        <ToastViewport />
        <ConfirmDialog />
      </div>
    </ErrorBoundary>
  );
}

function LoadingOverlay({ label }: { label: string }) {
  return (
    <div className="pointer-events-auto absolute inset-0 z-40 flex items-center justify-center bg-white/60 backdrop-blur-[1px]">
      <div className="flex flex-col items-center gap-3 rounded-lg bg-white px-6 py-5 shadow-lg">
        <Spinner />
        <span className="text-sm font-medium text-gray-700">{label}</span>
      </div>
    </div>
  );
}

function Spinner() {
  return (
    <Loader2
      size={32}
      className="animate-spin text-gray-700"
      aria-hidden="true"
    />
  );
}

export default App;
