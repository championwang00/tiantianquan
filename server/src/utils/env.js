import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(currentDir, "..", "..");
const projectRoot = path.resolve(serverRoot, "..");
const extensionConfigPath = path.join(projectRoot, "extension", "config.js");
export const envFilePath = path.join(serverRoot, ".env");

export function loadEnv() {
  const env = { ...process.env };
  const files = [
    envFilePath,
    path.resolve(".env")
  ];
  const file = files.find((candidate) => fs.existsSync(candidate));
  if (!file) return env;

  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index === -1) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, "");
    env[key] = value;
  }

  return env;
}

export function ensureLocalRouterToken(env) {
  const existing = String(env.LOCAL_CLIP_ROUTER_TOKEN || "").trim();
  if (existing && existing !== "change-me-local-token") {
    syncExtensionToken(existing);
    return { ...env, LOCAL_CLIP_ROUTER_TOKEN: existing };
  }

  const token = crypto.randomBytes(32).toString("hex");
  const nextEnv = { ...env, LOCAL_CLIP_ROUTER_TOKEN: token };
  writeEnvPatch(nextEnv);
  syncExtensionToken(token);
  return nextEnv;
}

function writeEnvPatch(env) {
  const existing = fs.existsSync(envFilePath) ? fs.readFileSync(envFilePath, "utf8") : "";
  const lines = existing.split(/\r?\n/);
  let replaced = false;
  const nextLines = lines.map((line) => {
    if (/^\s*LOCAL_CLIP_ROUTER_TOKEN\s*=/.test(line)) {
      replaced = true;
      return `LOCAL_CLIP_ROUTER_TOKEN=${env.LOCAL_CLIP_ROUTER_TOKEN}`;
    }
    return line;
  });
  if (!replaced) nextLines.unshift(`LOCAL_CLIP_ROUTER_TOKEN=${env.LOCAL_CLIP_ROUTER_TOKEN}`);
  fs.mkdirSync(path.dirname(envFilePath), { recursive: true });
  fs.writeFileSync(envFilePath, normalizeTrailingNewline(nextLines.join("\n")), "utf8");
}

function syncExtensionToken(token) {
  const content = `const DEFAULT_ROUTER_TOKEN = ${JSON.stringify(token)};\n`;
  fs.writeFileSync(extensionConfigPath, content, "utf8");
}

function normalizeTrailingNewline(value) {
  return `${String(value).replace(/\n*$/, "")}\n`;
}
