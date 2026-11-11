import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { chromium } from "playwright-core";

let queue = Promise.resolve();
const cache = new Map();

function browserPath(explicit) {
  const local = process.env.LOCALAPPDATA ?? "";
  const candidates = [explicit, process.env.AFGO_BROWSER, chromium.executablePath(),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Quark.app/Contents/MacOS/Quark",
    "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome",
    join(local, "Google", "Chrome", "Application", "chrome.exe"),
    join(process.env.PROGRAMFILES ?? "", "Google", "Chrome", "Application", "chrome.exe")];
  const found = candidates.find((path) => path && existsSync(path));
  if (!found) throw new Error("生成结构图需要本机 Chrome/Chromium。可在插件配置 browserExecutable 或环境变量 AFGO_BROWSER 中指定路径。");
  return found;
}

async function renderNow(payload, options) {
  options.signal?.throwIfAborted();
  const browser = await chromium.launch({ executablePath: browserPath(options.browserExecutable),
    headless: true, chromiumSandbox: true, timeout: 15000,
    args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
  const abort = () => { void browser.close().catch(() => {}); };
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    options.signal?.throwIfAborted();
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 }, deviceScaleFactor: 1 });
    await page.route("**/*", (route) => route.abort());
    await page.setContent(await readFile(new URL("./structure-viewer.html", import.meta.url), "utf8"));
    const result = await page.evaluate((input) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => { window.removeEventListener("message", receive); reject(new Error("Mol* 结构图生成超时")); }, 45000);
      function receive(event) {
        const message = event.data;
        if (event.source !== window || message?.source !== "afgo-molstar" || message.channel !== input.channel) return;
        if (message.type === "png" || message.type === "error") {
          clearTimeout(timer);
          window.removeEventListener("message", receive);
          if (message.type === "error") reject(new Error(message.message));
          else resolve({ content: message.content, manifest: message.manifest });
        }
      }
      window.addEventListener("message", receive);
      window.postMessage({ ...input, type: "afgo-structure", autoExport: true }, "*");
    }), { ...payload, channel: "report-" + payload.sha256 });
    const png = Buffer.from(result.content, "base64");
    if (png.byteLength > 4 * 1024 * 1024 || !png.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) {
      throw new Error("Mol* 未返回符合大小限制的 PNG 图片");
    }
    return { png, manifest: result.manifest };
  } finally {
    options.signal?.removeEventListener("abort", abort);
    await browser.close();
  }
}

export async function renderStructure(payload, options = {}) {
  const key = createHash("sha256").update(payload.text).update(payload.format).digest("hex");
  const cached = cache.get(key);
  if (cached) return { png: cached.png, manifest: { ...cached.manifest,
    taskId: payload.taskId, fileId: payload.fileId, name: payload.name,
    sha256: payload.sha256, fetchedAt: payload.fetchedAt } };
  const work = queue.then(() => renderNow(payload, options));
  queue = work.catch(() => {});
  const result = await work;
  cache.set(key, result);
  if (cache.size > 16) cache.delete(cache.keys().next().value);
  return result;
}
