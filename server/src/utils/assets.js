import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { safeFileName } from "./webpage.js";

export async function saveDataUrlAsset(dataUrl, baseName, ext = "png") {
  if (!dataUrl) return null;
  const match = String(dataUrl).match(/^data:([^;,]+);base64,(.+)$/);
  if (!match) return null;

  const mimeType = match[1];
  const buffer = Buffer.from(match[2], "base64");
  if (!buffer.length) return null;

  const extension = extensionFromMime(mimeType) || ext;
  const dir = path.join(os.tmpdir(), "tiantianquan-assets");
  await fs.mkdir(dir, { recursive: true });
  const filename = `${safeFileName(baseName)}.${extension}`;
  const filePath = path.join(dir, `${Date.now()}-${filename}`);
  await fs.writeFile(filePath, buffer);

  return {
    filePath,
    filename,
    mimeType,
    size: buffer.length
  };
}

function extensionFromMime(mimeType) {
  if (mimeType === "image/png") return "png";
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/webp") return "webp";
  return "";
}
