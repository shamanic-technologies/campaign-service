-- Rename to_resume_at column to next_run_at (values unchanged)
ALTER TABLE "campaigns" RENAME COLUMN "to_resume_at" TO "next_run_at";
