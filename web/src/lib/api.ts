export type DocumentMeta = {
  documentId: string;
  pageCount: number;
  filename: string;
};

export type FontEntry = {
  ref: string;
  psName: string;
  subsetTag: string | null;
  baseName: string;
  format: "woff2" | "ttf" | "otf" | null;
  url: string | null;
  bold: boolean;
  italic: boolean;
  fallbackFamily: string;
  masterUrl: string | null;
  masterPsName: string | null;
  masterFamily: string | null;
  availableCodepoints: number[];
  matchedBy: "psName" | "familyKeyword" | "panose" | "fallback" | null;
  fsType?: number | null;
  fsTypeLabel?: "installable" | "restricted" | "preview" | "editable" | null;
};

export type Span = {
  text: string;
  fontPsName: string;
  fontRef: string | null;
  size: number;
  colorRgb: [number, number, number];
  bold: boolean;
  italic: boolean;
};

export type Fragment = {
  id: string;
  bbox: [number, number, number, number];
  text: string;
  spans: Span[];
  rotation?: number;
  writingMode?: "horizontal-tb" | "vertical-rl" | "vertical-lr";
  isFormField?: boolean;
  formFieldType?:
    | "button"
    | "checkbox"
    | "combobox"
    | "listbox"
    | "radio"
    | "signature"
    | "text"
    | null;
  formFieldName?: string | null;
  isFromXObject?: boolean;
};

export type PageData = {
  index: number;
  widthPt: number;
  heightPt: number;
  rotation: number;
  fragments: Fragment[];
  appearsScanned?: boolean;
  invisibleTextRatio?: number;
  imageCoverageRatio?: number;
};

export type DocumentResponse = {
  documentId: string;
  filename: string;
  pageCount: number;
  fonts: FontEntry[];
  pages: PageData[];
};

export type Align = "left" | "center" | "right" | "justify";
export type Rgb = [number, number, number];

export type SpanDelta = {
  text: string;
  fontRef: string | null;
  size: number;
  colorRgb: Rgb;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strikethrough: boolean;
};

export type Edit = {
  fragId: string;
  pageIndex: number;
  originalBBox: [number, number, number, number];
  newBBox: [number, number, number, number];
  newText: string;
  fontRef: string | null;
  size: number;
  colorRgb: Rgb;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strikethrough: boolean;
  align: Align;
  // Optional: when present, takes precedence over the uniform style fields
  // above. newText remains the canonical string representation
  // (newSpans.map(s => s.text).join("")) for backward compatibility.
  newSpans?: SpanDelta[];
};

export type TextInsertion = {
  id: string;
  type: "text";
  pageIndex: number;
  bbox: [number, number, number, number];
  text: string;
  fontKey: string;
  size: number;
  colorRgb: Rgb;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strikethrough: boolean;
  align: Align;
};

export type ShapeInsertion = {
  id: string;
  type: "rectangle" | "ellipse";
  pageIndex: number;
  bbox: [number, number, number, number];
  strokeRgb: Rgb | null;
  fillRgb: Rgb | null;
  strokeWidth: number;
};

export type LineInsertion = {
  id: string;
  type: "line" | "arrow";
  pageIndex: number;
  fromPt: [number, number];
  toPt: [number, number];
  strokeRgb: Rgb;
  strokeWidth: number;
};

export type ImageInsertion = {
  id: string;
  type: "image";
  pageIndex: number;
  bbox: [number, number, number, number];
  imageRef: string;
};

export type Insertion =
  | TextInsertion
  | ShapeInsertion
  | LineInsertion
  | ImageInsertion;

export type InsertTool =
  | "text"
  | "rectangle"
  | "ellipse"
  | "line"
  | "arrow"
  | "image";

export type UploadImageResponse = {
  imageRef: string;
  url: string;
  widthPx: number;
  heightPx: number;
};

export async function uploadPdf(file: File): Promise<DocumentMeta> {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch("/api/upload", {
    method: "POST",
    body: form,
  });
  if (!res.ok) {
    throw new Error(`Upload failed: ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as DocumentMeta;
}

export type UploadJobResponse = {
  jobId: string;
  documentId: string;
};

export type UploadProgressEvent =
  | { phase: "fonts" | "pages"; done: number; total: number }
  | { done: true; documentId: string }
  | { error: string };

export async function uploadPdfStreaming(file: File): Promise<UploadJobResponse> {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch("/api/upload/streaming", {
    method: "POST",
    body: form,
  });
  if (!res.ok) {
    throw new Error(`Upload failed: ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as UploadJobResponse;
}

export function streamUploadProgress(
  jobId: string,
  onEvent: (e: UploadProgressEvent) => void,
): () => void {
  const es = new EventSource(`/api/upload/${encodeURIComponent(jobId)}/events`);
  es.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data) as UploadProgressEvent;
      onEvent(data);
      if ("done" in data || "error" in data) {
        es.close();
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("SSE parse error", err);
    }
  };
  es.onerror = () => {
    es.close();
    onEvent({ error: "Lost connection to server" });
  };
  return () => es.close();
}

export async function getDocument(documentId: string): Promise<DocumentResponse> {
  const res = await fetch(`/api/doc/${encodeURIComponent(documentId)}`);
  if (!res.ok) {
    throw new Error(`getDocument failed: ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as DocumentResponse;
  if (!Array.isArray(data.fonts)) {
    data.fonts = [];
  }
  return data;
}

export function getPdfUrl(documentId: string): string {
  return `/api/doc/${encodeURIComponent(documentId)}/pdf`;
}

export function getImageUrl(documentId: string, imageRef: string): string {
  return `/api/doc/${encodeURIComponent(documentId)}/images/${encodeURIComponent(imageRef)}`;
}

export async function getPdfBlobUrl(documentId: string): Promise<string> {
  const res = await fetch(getPdfUrl(documentId));
  if (!res.ok) {
    throw new Error(`getPdfBlobUrl failed: ${res.status} ${res.statusText}`);
  }
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}

export async function uploadImage(
  documentId: string,
  file: File,
): Promise<UploadImageResponse> {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch(`/api/doc/${encodeURIComponent(documentId)}/images`, {
    method: "POST",
    body: form,
  });
  if (!res.ok) {
    throw new Error(`uploadImage failed: ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as UploadImageResponse;
}

export type SavePayload = {
  edits: Edit[];
  insertions: Insertion[];
};

export type SaveWarningCode =
  | "text_overflow"
  | "ocr_layer"
  | "form_field"
  | "xobject_shared"
  | "rotation_lost"
  | "vertical_lost";

export type SaveWarning = {
  fragId: string | null;
  insertionId: string | null;
  pageIndex: number;
  code: SaveWarningCode;
  message: string;
};

export type SaveResponse = {
  document: DocumentResponse;
  warnings: SaveWarning[];
};

export async function saveDocument(
  documentId: string,
  payload: SavePayload,
): Promise<SaveResponse> {
  const res = await fetch(`/api/doc/${encodeURIComponent(documentId)}/save`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(`saveDocument failed: ${res.status} ${res.statusText}`);
  }
  const raw = (await res.json()) as Partial<SaveResponse> & Partial<DocumentResponse>;
  // Accept either the new envelope { document, warnings } or a bare
  // DocumentResponse for backward-compat while the backend is rolled out.
  let document: DocumentResponse;
  let warnings: SaveWarning[];
  if (raw && typeof raw === "object" && "document" in raw && raw.document) {
    document = raw.document as DocumentResponse;
    warnings = Array.isArray((raw as SaveResponse).warnings)
      ? (raw as SaveResponse).warnings
      : [];
  } else {
    document = raw as DocumentResponse;
    warnings = [];
  }
  if (!Array.isArray(document.fonts)) {
    document.fonts = [];
  }
  return { document, warnings };
}

async function parseDocumentResponse(res: Response, label: string): Promise<DocumentResponse> {
  if (!res.ok) {
    throw new Error(`${label} failed: ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as DocumentResponse;
  if (!Array.isArray(data.fonts)) {
    data.fonts = [];
  }
  return data;
}

export async function addPage(
  documentId: string,
  atIndex: number,
  widthPt?: number,
  heightPt?: number,
): Promise<DocumentResponse> {
  const body: { atIndex: number; widthPt?: number; heightPt?: number } = { atIndex };
  if (widthPt !== undefined) body.widthPt = widthPt;
  if (heightPt !== undefined) body.heightPt = heightPt;
  const res = await fetch(`/api/doc/${encodeURIComponent(documentId)}/pages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return parseDocumentResponse(res, "addPage");
}

export async function deletePage(
  documentId: string,
  index: number,
): Promise<DocumentResponse> {
  const res = await fetch(
    `/api/doc/${encodeURIComponent(documentId)}/pages/${index}`,
    { method: "DELETE" },
  );
  return parseDocumentResponse(res, "deletePage");
}

export async function reorderPages(
  documentId: string,
  order: number[],
): Promise<DocumentResponse> {
  const res = await fetch(
    `/api/doc/${encodeURIComponent(documentId)}/pages/reorder`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ order }),
    },
  );
  return parseDocumentResponse(res, "reorderPages");
}
