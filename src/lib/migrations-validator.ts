import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

interface JournalEntry {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
}

interface Journal {
  version: string;
  dialect: string;
  entries: JournalEntry[];
}

interface ValidationResult {
  errors: string[];
}

export function validateMigrationsJournal({ migrationsDir }: { migrationsDir: string }): ValidationResult {
  const errors: string[] = [];

  const journalPath = join(migrationsDir, "meta", "_journal.json");
  const journal: Journal = JSON.parse(readFileSync(journalPath, "utf8"));

  const sqlTags = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => f.replace(/\.sql$/, ""))
    .sort();

  const journalTags = new Set(journal.entries.map((e) => e.tag));
  const sqlSet = new Set(sqlTags);

  for (const tag of sqlTags) {
    if (!journalTags.has(tag)) {
      errors.push(`Missing journal entry: ${tag}`);
    }
  }

  for (const entry of journal.entries) {
    if (!sqlSet.has(entry.tag)) {
      errors.push(`Missing SQL file: ${entry.tag}.sql`);
    }
  }

  const sortedByIdx = [...journal.entries].sort((a, b) => a.idx - b.idx);
  for (let i = 0; i < sortedByIdx.length; i++) {
    if (sortedByIdx[i].idx !== i) {
      errors.push(`Index gap at ${i}, found idx ${sortedByIdx[i].idx}`);
      break;
    }
  }

  const idxSeen = new Set<number>();
  for (const entry of journal.entries) {
    if (idxSeen.has(entry.idx)) {
      errors.push(`Duplicate idx: ${entry.idx}`);
      break;
    }
    idxSeen.add(entry.idx);
  }

  const tagSeen = new Set<string>();
  for (const entry of journal.entries) {
    if (tagSeen.has(entry.tag)) {
      errors.push(`Duplicate tag: ${entry.tag}`);
      break;
    }
    tagSeen.add(entry.tag);
  }

  return { errors };
}
