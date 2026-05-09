import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateMigrationsJournal } from "../../src/lib/migrations-validator.js";

interface JournalEntry {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
}

function makeEntry(idx: number, tag: string): JournalEntry {
  return { idx, version: "7", when: 1_000_000_000_000 + idx, tag, breakpoints: true };
}

function setupRepo(entries: JournalEntry[], sqlTags: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "drizzle-test-"));
  mkdirSync(join(dir, "meta"), { recursive: true });
  writeFileSync(
    join(dir, "meta", "_journal.json"),
    JSON.stringify({ version: "7", dialect: "postgresql", entries }, null, 2),
  );
  for (const tag of sqlTags) {
    writeFileSync(join(dir, `${tag}.sql`), `-- ${tag}\nSELECT 1;`);
  }
  return dir;
}

describe("validateMigrationsJournal", () => {
  let tmpDir: string | null = null;

  afterEach(() => {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  it("clean state passes", () => {
    tmpDir = setupRepo(
      [makeEntry(0, "0000_init"), makeEntry(1, "0001_add_brands")],
      ["0000_init", "0001_add_brands"],
    );
    const result = validateMigrationsJournal({ migrationsDir: tmpDir });
    expect(result.errors).toEqual([]);
  });

  it("flags SQL file without journal entry", () => {
    tmpDir = setupRepo(
      [makeEntry(0, "0000_init")],
      ["0000_init", "0001_orphan_sql"],
    );
    const result = validateMigrationsJournal({ migrationsDir: tmpDir });
    expect(result.errors).toContain("Missing journal entry: 0001_orphan_sql");
  });

  it("flags journal entry without SQL file", () => {
    tmpDir = setupRepo(
      [makeEntry(0, "0000_init"), makeEntry(1, "0001_orphan_journal")],
      ["0000_init"],
    );
    const result = validateMigrationsJournal({ migrationsDir: tmpDir });
    expect(result.errors).toContain("Missing SQL file: 0001_orphan_journal.sql");
  });

  it("flags index gap", () => {
    tmpDir = setupRepo(
      [makeEntry(0, "0000_init"), makeEntry(2, "0002_skip")],
      ["0000_init", "0002_skip"],
    );
    const result = validateMigrationsJournal({ migrationsDir: tmpDir });
    expect(result.errors.some((e) => e.startsWith("Index gap"))).toBe(true);
  });

  it("flags duplicate idx", () => {
    tmpDir = setupRepo(
      [makeEntry(0, "0000_init"), makeEntry(0, "0000_dup")],
      ["0000_init", "0000_dup"],
    );
    const result = validateMigrationsJournal({ migrationsDir: tmpDir });
    expect(result.errors.some((e) => e.startsWith("Duplicate idx"))).toBe(true);
  });

  it("flags duplicate tag", () => {
    tmpDir = setupRepo(
      [makeEntry(0, "0000_init"), makeEntry(1, "0000_init")],
      ["0000_init"],
    );
    const result = validateMigrationsJournal({ migrationsDir: tmpDir });
    expect(result.errors.some((e) => e.startsWith("Duplicate tag"))).toBe(true);
  });

  it("real repo journal is consistent", () => {
    const repoMigrations = join(process.cwd(), "drizzle");
    const result = validateMigrationsJournal({ migrationsDir: repoMigrations });
    expect(result.errors).toEqual([]);
  });
});
