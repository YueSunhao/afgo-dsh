/**
 * Task inputs as the workbench shows them.
 *
 * The platform returns a Kit task's `args` as a flat object. File arguments
 * are encoded as `argFile:<base64 path>|<name>|<ext>|<bytes>`; the base64
 * part is a server path, so only the display name is kept. Nested objects and
 * long strings are dropped or shortened: this is a summary for people, the raw
 * arguments stay on the platform.
 */

const MAX_INPUTS = 12;
const MAX_TEXT = 80;

function fileArg(text) {
  const parts = text.slice("argFile:".length).split("|");
  const name = parts[1] && parts[1].trim() ? parts[1].trim() : null;
  const bytes = Number(parts[3]);
  return { kind: "file", value: name ?? "文件", bytes: Number.isFinite(bytes) && bytes >= 0 ? bytes : null };
}

/** @returns {{ key: string, value: string, kind: "file"|"value", bytes?: number|null }[]} */
export function inputsOf(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return [];
  const out = [];
  for (const [key, raw] of Object.entries(args)) {
    if (out.length >= MAX_INPUTS) break;
    if (!/^[\w.-]{1,64}$/.test(key)) continue;
    if (typeof raw === "string") {
      const text = raw.trim();
      if (!text) continue;
      if (text.startsWith("argFile:")) { out.push({ key, ...fileArg(text) }); continue; }
      out.push({ key, kind: "value", value: text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text });
    } else if (typeof raw === "number" && Number.isFinite(raw)) {
      out.push({ key, kind: "value", value: String(raw) });
    } else if (typeof raw === "boolean") {
      out.push({ key, kind: "value", value: raw ? "是" : "否" });
    } else if (Array.isArray(raw) && raw.length <= 6 && raw.every((item) => ["string", "number"].includes(typeof item))) {
      const text = raw.join(", ");
      out.push({ key, kind: "value", value: text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text });
    }
  }
  return out;
}
