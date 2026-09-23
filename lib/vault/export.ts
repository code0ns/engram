import fs from "node:fs";
import path from "node:path";
import { ZipArchive } from "archiver";
import { Readable } from "node:stream";

export interface ExportOptions {
  /** Include .git directory in the zip. Default false (smaller, notes-only backup). */
  includeGit?: boolean;
}

/**
 * Create a streaming zip of a vault directory for backup/download.
 *
 * Returns a ReadableStream (web standard) that can be returned directly from a route,
 * plus a suggested filename. Streams the zip - does not load the entire vault into memory.
 *
 * By default excludes .git (smaller download). Set includeGit: true to include it
 * (full repo backup with history, but much larger).
 */
export async function createVaultZip(
  vaultDir: string,
  workspaceName: string,
  options: ExportOptions = {},
): Promise<{ stream: ReadableStream<Uint8Array>; filename: string }> {
  const { includeGit = false } = options;

  // Verify the directory exists
  if (!fs.existsSync(vaultDir)) {
    throw new Error(`vault directory does not exist: ${vaultDir}`);
  }

  // Generate a safe filename
  const safeName = workspaceName.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 50) || "vault";
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const filename = `${safeName}_${timestamp}.zip`;

  // Create the archiver instance
  const archive = new ZipArchive({
    zlib: { level: 6 }, // Balanced compression
  });

  // Handle archiver errors
  archive.on("error", (err) => {
    console.error("[vault/export] archiver error:", err);
    throw err;
  });

  // Add the vault directory contents
  archive.directory(vaultDir, false, (entry) => {
    // Filter out .git unless explicitly requested
    if (!includeGit && entry.name.startsWith(".git")) {
      return false;
    }
    return entry;
  });

  // Finalize the archive
  archive.finalize();

  // Convert Node.js readable stream to web ReadableStream
  const nodeStream = archive as unknown as Readable;
  const webStream = Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;

  return { stream: webStream, filename };
}

/**
 * Get an estimate of the vault size (for UI display).
 * Returns size in bytes, excluding .git by default.
 */
export function estimateVaultSize(vaultDir: string, includeGit: boolean = false): number {
  if (!fs.existsSync(vaultDir)) return 0;

  let totalSize = 0;

  function walkDir(dir: string): void {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        // Skip .git unless requested
        if (!includeGit && entry.name === ".git") continue;

        if (entry.isDirectory()) {
          walkDir(fullPath);
        } else if (entry.isFile()) {
          try {
            const stat = fs.statSync(fullPath);
            totalSize += stat.size;
          } catch {
            // Skip files we can't stat
          }
        }
      }
    } catch {
      // Skip directories we can't read
    }
  }

  walkDir(vaultDir);
  return totalSize;
}
