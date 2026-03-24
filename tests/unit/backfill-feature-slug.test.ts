import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

describe("0024_backfill_feature_slug migration", () => {
  const sql = readFileSync(
    resolve(__dirname, "../../drizzle/0024_backfill_feature_slug.sql"),
    "utf-8"
  );

  it("updates feature_slug for sales-email-cold-outreach workflows", () => {
    expect(sql).toContain("UPDATE \"campaigns\"");
    expect(sql).toContain("\"feature_slug\" = 'sales-cold-email-outreach'");
    expect(sql).toContain("\"workflow_name\" LIKE 'sales-email-cold-outreach-%'");
  });

  it("only backfills rows where feature_slug is null", () => {
    expect(sql).toContain("\"feature_slug\" IS NULL");
  });

  it("does not drop or alter any columns", () => {
    expect(sql.toUpperCase()).not.toContain("DROP");
    expect(sql.toUpperCase()).not.toContain("ALTER");
    expect(sql.toUpperCase()).not.toContain("DELETE");
  });
});
