import { XMLParser } from "fast-xml-parser";
import { safeUrl } from "../domain/urls.js";

/** Feed/store snippets only; never copy an article body. */
export function plainText(value: unknown, maximum = 420): string {
  if (typeof value !== "string") return "";
  const clean = (s: string) => s
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
  const stripped = clean(value);
  const decoded = new XMLParser({ parseTagValue: false, htmlEntities: true }).parse(
    "<t>" + stripped.replace(/&(?!#\d+;|#x[\da-f]+;|[a-z]+;)/gi, "&amp;") + "</t>",
  ).t;
  return clean(typeof decoded === "string" ? decoded : decoded?.["#text"] ?? "")
    .replace(/\s+/g, " ").trim().slice(0, maximum);
}

export function imageUrl(value: unknown): string | null {
  const url = safeUrl(value);
  if (!url || url.length > 2048) return null;
  const parsed = new URL(url);
  // Telegram fetches these URLs; only accept public HTTPS image references.
  if (
    parsed.port || !parsed.hostname.includes(".") ||
    /^[\d.]+$/.test(parsed.hostname) || parsed.hostname.includes(":") ||
    /(?:^|\.)(localhost|local|internal|test)$/.test(parsed.hostname)
  ) return null;
  return url;
}
