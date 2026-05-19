// Feature-detection for browser capabilities the editor depends on. Run once
// at app boot so we can surface a single toast rather than failing silently
// inside a deeply nested component.

const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";

export const browserSupport = {
  pointerEvents:
    typeof window !== "undefined" && "PointerEvent" in window,
  eventSource:
    typeof window !== "undefined" && "EventSource" in window,
  execCommand:
    typeof document !== "undefined" &&
    typeof document.execCommand === "function",
  isFirefox: /Firefox/.test(ua),
  isSafari: /^((?!chrome|android).)*safari/i.test(ua),
  isMobile: /Mobi|Android|iPhone/i.test(ua),
};

export function assertCriticalSupport(): string[] {
  const missing: string[] = [];
  if (!browserSupport.pointerEvents) missing.push("PointerEvent");
  if (!browserSupport.eventSource) missing.push("EventSource");
  return missing;
}
