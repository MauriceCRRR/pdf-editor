import { useEffect, useRef, useState } from "react";
import type { PageData } from "../lib/api";
import type { PDFDocumentProxy } from "../lib/pdfjs";
import { PdfPage } from "./PdfPage";

const EAGER_PAGES = 5;
const DEFAULT_CSS_SCALE = 1.25;

type Props = {
  pdf: PDFDocumentProxy;
  pages: PageData[];
};

export function PageStack({ pdf, pages }: Props) {
  return (
    <main className="flex-1 overflow-y-auto bg-gray-100 p-8">
      <div className="mx-auto flex max-w-4xl flex-col items-center gap-6">
        {pages.map((p) => (
          <PageSlot
            key={p.index}
            pdf={pdf}
            pageData={p}
            eager={p.index < EAGER_PAGES}
          />
        ))}
      </div>
    </main>
  );
}

function PageSlot({
  pdf,
  pageData,
  eager,
}: {
  pdf: PDFDocumentProxy;
  pageData: PageData;
  eager: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(eager);
  const pageNumber = pageData.index + 1;

  useEffect(() => {
    if (visible) return;
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setVisible(true);
            observer.disconnect();
            break;
          }
        }
      },
      { rootMargin: "400px 0px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [visible]);

  const placeholderStyle: React.CSSProperties = {
    width: `${pageData.widthPt * DEFAULT_CSS_SCALE}px`,
    height: `${pageData.heightPt * DEFAULT_CSS_SCALE}px`,
  };

  return (
    <div
      ref={ref}
      id={`page-${pageNumber}`}
      className="flex w-full flex-col items-center"
    >
      <div className="mb-1 text-xs text-gray-400">Page {pageNumber}</div>
      {visible ? (
        <PdfPage pdf={pdf} pageNumber={pageNumber} pageData={pageData} />
      ) : (
        <div
          style={placeholderStyle}
          className="animate-pulse rounded bg-white shadow-sm"
        />
      )}
    </div>
  );
}
