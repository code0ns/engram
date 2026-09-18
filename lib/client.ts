export type { Note, NoteMeta, TreeNode, Graph, GraphNode, GraphEdge } from "@/lib/vault/types";

export const fetcher = (url: string) =>
  fetch(url).then((r) => {
    if (!r.ok) throw new Error(`${r.status}`);
    return r.json();
  });

/** Seed colors for the sample vault's own taxonomy — kept so a fresh clone still looks curated
 *  out of the box. A real vault's folder names won't match these; see `hashColor` below. */
export const FOLDER_COLORS: Record<string, string> = {
  clients: "#3b82f6",
  decisions: "#a855f7",
  projects: "#22c55e",
  people: "#f59e0b",
  meetings: "#ec4899",
  research: "#06b6d4",
  docs: "#64748b",
  milestones: "#ef4444",
  inbox: "#eab308",
  "bm-remember": "#14b8a6",
  ops: "#10b981",
  daily: "#8b5cf6",
  archive: "#71717a",
  root: "#a1a1aa",
};

/**
 * Deterministic HSL color from a folder name, so any folder gets a stable, distinguishable
 * color even outside FOLDER_COLORS or a user override. Previously every folder not in the
 * sample-vault's taxonomy fell through to one flat gray ("#a1a1aa") — which was every folder,
 * in any real vault.
 */
function hashColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash << 5) - hash + name.charCodeAt(i);
    hash |= 0;
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue} 62% 55%)`;
}

/**
 * Resolve a folder's display color: a user override (set via the sidebar's color picker) wins,
 * then the sample-vault seed map, then the hash fallback — so nothing renders flat gray.
 */
export function folderColor(folder: string, overrides?: Record<string, string>): string {
  return overrides?.[folder] ?? FOLDER_COLORS[folder] ?? hashColor(folder);
}
