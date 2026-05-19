import type { FontEntry, Span } from "./api";

export type RegisteredFonts = {
  subsetByRef: Map<string, string>;
  masterByRef: Map<string, string>;
  faces: FontFace[];
};

function subsetFamilyName(documentId: string, ref: string): string {
  return `pdfFont_${documentId}_${ref}`;
}

function masterFamilyName(documentId: string, ref: string): string {
  return `pdfFont_${documentId}_${ref}_master`;
}

type LoadResult =
  | { kind: "subset"; ref: string; family: string; face: FontFace }
  | { kind: "master"; ref: string; family: string; face: FontFace };

async function loadFace(
  family: string,
  url: string,
  descriptors: FontFaceDescriptors,
): Promise<FontFace> {
  const face = new FontFace(family, `url(${url})`, descriptors);
  await face.load();
  document.fonts.add(face);
  return face;
}

export async function registerFonts(
  documentId: string,
  fonts: FontEntry[],
): Promise<RegisteredFonts> {
  const subsetByRef = new Map<string, string>();
  const masterByRef = new Map<string, string>();
  const faces: FontFace[] = [];

  if (typeof document === "undefined" || !document.fonts) {
    return { subsetByRef, masterByRef, faces };
  }

  const tasks: Promise<LoadResult | null>[] = [];
  const taskMeta: { entry: FontEntry; kind: "subset" | "master" }[] = [];

  for (const entry of fonts) {
    const descriptors: FontFaceDescriptors = {
      weight: entry.bold ? "700" : "400",
      style: entry.italic ? "italic" : "normal",
      display: "swap",
    };
    if (entry.url) {
      const family = subsetFamilyName(documentId, entry.ref);
      tasks.push(
        loadFace(family, entry.url, descriptors).then((face) => ({
          kind: "subset" as const,
          ref: entry.ref,
          family,
          face,
        })),
      );
      taskMeta.push({ entry, kind: "subset" });
    }
    if (entry.masterUrl) {
      const family = masterFamilyName(documentId, entry.ref);
      tasks.push(
        loadFace(family, entry.masterUrl, descriptors).then((face) => ({
          kind: "master" as const,
          ref: entry.ref,
          family,
          face,
        })),
      );
      taskMeta.push({ entry, kind: "master" });
    }
  }

  const results = await Promise.allSettled(tasks);
  for (let i = 0; i < results.length; i += 1) {
    const result = results[i];
    const meta = taskMeta[i];
    if (result.status === "fulfilled" && result.value) {
      if (result.value.kind === "subset") {
        subsetByRef.set(result.value.ref, result.value.family);
      } else {
        masterByRef.set(result.value.ref, result.value.family);
      }
      faces.push(result.value.face);
    } else if (result.status === "rejected") {
      console.warn(
        `[fonts] failed to load ${meta.kind} font ${meta.entry.psName} (ref=${meta.entry.ref}):`,
        result.reason,
      );
    }
  }

  console.log(
    `[fonts] Registered ${subsetByRef.size} subset + ${masterByRef.size} master fonts for document ${documentId}`,
  );

  return { subsetByRef, masterByRef, faces };
}

export function unregisterFonts(faces: FontFace[]): void {
  if (typeof document === "undefined" || !document.fonts) return;
  for (const face of faces) {
    document.fonts.delete(face);
  }
}

export function isTextInSubset(text: string, codepoints: Set<number>): boolean {
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp === undefined) continue;
    if (!codepoints.has(cp)) return false;
  }
  return true;
}

export function fontFamilyForSpan(
  span: Span,
  fontByRef: Map<string, FontEntry>,
  subsetByRef: Map<string, string>,
  masterByRef: Map<string, string>,
  useMaster: boolean,
): string {
  const ref = span.fontRef;
  if (!ref) return "ui-sans-serif, system-ui, sans-serif";

  const entry = fontByRef.get(ref);
  const subsetFamily = subsetByRef.get(ref) ?? null;
  const masterFamily = masterByRef.get(ref) ?? null;
  const fallback = entry?.fallbackFamily ?? "ui-sans-serif, system-ui, sans-serif";

  const chain: string[] = [];
  if (useMaster) {
    if (masterFamily) chain.push(`"${masterFamily}"`);
    if (subsetFamily) chain.push(`"${subsetFamily}"`);
  } else {
    if (subsetFamily) chain.push(`"${subsetFamily}"`);
    if (masterFamily) chain.push(`"${masterFamily}"`);
  }
  chain.push(fallback);
  return chain.join(", ");
}
