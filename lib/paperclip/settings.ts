import fs from "node:fs";
import path from "node:path";
import { DATA_ROOT } from "@/lib/config";
import { decryptSecret, encryptSecret } from "@/lib/crypto";

/**
 * Connection settings for a Paperclip instance (paperclipai/paperclip) — a separate
 * agent-orchestration control plane Engram's Agents page talks to over its REST API.
 * Kept as its own store/route (not folded into lib/settings.ts) so this integration
 * stays a clean add/remove.
 */

const STATE_DIR = process.env.ENGRAM_STATE_DIR || DATA_ROOT;
const SETTINGS_FILE = path.join(STATE_DIR, "paperclip-settings.json");

interface StoredSettings {
  baseUrl?: string;
  /** Empty is valid — Paperclip's local trusted mode needs no key. */
  apiKeyEnc?: string;
  /** Set when Paperclip runs inside WSL on this same Windows host (e.g. "Ubuntu-24.04"). */
  wslDistro?: string;
}

let cache: StoredSettings | null = null;

function load(): StoredSettings {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
  } catch {
    cache = {};
  }
  return cache!;
}

function save(s: StoredSettings): void {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2));
  cache = s;
}

function safeDecrypt(enc?: string): string {
  if (!enc) return "";
  try {
    return decryptSecret(enc);
  } catch {
    return "";
  }
}

const DEFAULT_BASE_URL = "http://localhost:3100/api";

export function paperclipBaseUrl(): string {
  return (load().baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

export function paperclipApiKey(): string {
  return safeDecrypt(load().apiKeyEnc);
}

export function paperclipWslDistro(): string {
  return load().wslDistro?.trim() || "";
}

/** Configured enough to try talking to it — a base URL is always present (has a default). */
export function paperclipConfigured(): boolean {
  return paperclipBaseUrl() !== "";
}

export interface PublicPaperclipSettings {
  baseUrl: string;
  apiKeySet: boolean;
  wslDistro: string;
}

export function publicPaperclipSettings(): PublicPaperclipSettings {
  return { baseUrl: paperclipBaseUrl(), apiKeySet: paperclipApiKey() !== "", wslDistro: paperclipWslDistro() };
}

export interface PaperclipSettingsPatch {
  baseUrl?: string;
  apiKey?: string;
  clearApiKey?: boolean;
  wslDistro?: string;
}

export function updatePaperclipSettings(patch: PaperclipSettingsPatch): PublicPaperclipSettings {
  const s = { ...load() };

  if (patch.baseUrl !== undefined) {
    const v = patch.baseUrl.trim();
    if (v === "") delete s.baseUrl;
    else s.baseUrl = v;
  }

  if (patch.wslDistro !== undefined) {
    const v = patch.wslDistro.trim();
    if (v === "") delete s.wslDistro;
    else s.wslDistro = v;
  }

  if (patch.clearApiKey) delete s.apiKeyEnc;
  else if (patch.apiKey && patch.apiKey.trim() !== "") s.apiKeyEnc = encryptSecret(patch.apiKey.trim());

  save(s);
  return publicPaperclipSettings();
}
