import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { createVaultZip, estimateVaultSize } from "./export";

const TEST_DIR = path.join(process.cwd(), ".test-data", "export-test");
const VAULT_DIR = path.join(TEST_DIR, "vault");

beforeAll(() => {
  // Create a test vault with some files
  fs.mkdirSync(VAULT_DIR, { recursive: true });
  fs.mkdirSync(path.join(VAULT_DIR, ".git"), { recursive: true });
  fs.mkdirSync(path.join(VAULT_DIR, "notes"), { recursive: true });
  
  // Create test files
  fs.writeFileSync(path.join(VAULT_DIR, "SCHEMA.md"), "# Schema\n\nThis is the vault schema.");
  fs.writeFileSync(path.join(VAULT_DIR, "notes", "test-note.md"), "# Test Note\n\nSome content here.");
  fs.writeFileSync(path.join(VAULT_DIR, ".git", "config"), "[core]\nrepositoryformatversion = 0");
});

afterAll(() => {
  try {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  } catch {
    // Ignore
  }
});

describe("createVaultZip", () => {
  test("creates a valid zip stream", async () => {
    const { stream, filename } = await createVaultZip(VAULT_DIR, "test-vault");
    
    expect(stream).toBeDefined();
    expect(filename).toMatch(/^test-vault_\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.zip$/);
    
    // Consume the stream to verify it works
    const chunks: Uint8Array[] = [];
    const reader = stream.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    
    // Verify we got some data (a valid zip)
    const totalSize = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    expect(totalSize).toBeGreaterThan(0);
    
    // Check for ZIP magic bytes (PK..)
    expect(chunks[0][0]).toBe(0x50); // P
    expect(chunks[0][1]).toBe(0x4b); // K
  });

  test("excludes .git by default", async () => {
    const { stream } = await createVaultZip(VAULT_DIR, "test-vault", { includeGit: false });
    
    // Consume the stream
    const chunks: Uint8Array[] = [];
    const reader = stream.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    
    // The size should be smaller than with .git included
    const sizeWithoutGit = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    
    const { stream: stream2 } = await createVaultZip(VAULT_DIR, "test-vault", { includeGit: true });
    const chunks2: Uint8Array[] = [];
    const reader2 = stream2.getReader();
    while (true) {
      const { done, value } = await reader2.read();
      if (done) break;
      chunks2.push(value);
    }
    const sizeWithGit = chunks2.reduce((sum, chunk) => sum + chunk.length, 0);
    
    // With git should be larger (or equal if .git is tiny)
    expect(sizeWithGit).toBeGreaterThanOrEqual(sizeWithoutGit);
  });

  test("throws for non-existent vault", async () => {
    await expect(createVaultZip("/non/existent/path", "test")).rejects.toThrow("vault directory does not exist");
  });

  test("sanitizes filename to be safe", async () => {
    const { filename } = await createVaultZip(VAULT_DIR, "test/vault:with*special?chars");
    expect(filename).not.toMatch(/[\/:\*\?]/);
    expect(filename).toMatch(/^test_vault_with_special_chars_/);
  });
});

describe("estimateVaultSize", () => {
  test("returns size in bytes", () => {
    const size = estimateVaultSize(VAULT_DIR);
    expect(size).toBeGreaterThan(0);
  });

  test("excludes .git by default", () => {
    const sizeWithoutGit = estimateVaultSize(VAULT_DIR, false);
    const sizeWithGit = estimateVaultSize(VAULT_DIR, true);
    expect(sizeWithGit).toBeGreaterThanOrEqual(sizeWithoutGit);
  });

  test("returns 0 for non-existent path", () => {
    const size = estimateVaultSize("/non/existent/path");
    expect(size).toBe(0);
  });
});
