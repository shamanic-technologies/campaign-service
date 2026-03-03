import { describe, it, expect, vi, beforeEach } from "vitest";
import { migrateOrgs, migrateUsers } from "../../scripts/migrate-clerk-to-client-ids.js";

// Minimal tagged-template mock that mimics postgres `sql` usage.
// The first call returns `rows` (SELECT); subsequent calls return [] (UPDATEs).
function createMockSql(rows: Record<string, unknown>[]) {
  let callCount = 0;
  const fn = async () => {
    callCount++;
    return callCount === 1 ? rows : [];
  };
  return fn as unknown as Parameters<typeof migrateOrgs>[0];
}

// Tracking mock that records UPDATE values
function createTrackingSql(rows: Record<string, unknown>[]) {
  let callCount = 0;
  const updates: Record<string, unknown>[] = [];
  const fn = async (_strings: TemplateStringsArray, ..._values: unknown[]) => {
    callCount++;
    if (callCount === 1) return rows;
    updates.push({ newValue: _values[0], id: _values[1] });
    return [];
  };
  return { sql: fn as unknown as Parameters<typeof migrateOrgs>[0], updates };
}

describe("migrate-clerk-to-client-ids", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("migrateOrgs", () => {
    it("resolves Clerk IDs and returns success count", async () => {
      const rows = [
        { id: "aaa-local-uuid", org_id: "org_2abc" },
        { id: "bbb-local-uuid", org_id: "org_2def" },
      ];
      const { sql: mockSql, updates } = createTrackingSql(rows);

      const resolve = vi.fn()
        .mockResolvedValueOnce("aaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")
        .mockResolvedValueOnce("bbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");

      const result = await migrateOrgs(mockSql, resolve);

      expect(result).toEqual({ success: 2, skipped: 0, failed: 0 });
      expect(resolve).toHaveBeenCalledWith("org_2abc");
      expect(resolve).toHaveBeenCalledWith("org_2def");
      expect(updates).toHaveLength(2);
      expect(updates[0]).toEqual({ newValue: "aaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", id: "aaa-local-uuid" });
    });

    it("skips rows that already have UUID values", async () => {
      const rows = [
        { id: "aaa", org_id: "f47ac10b-58cc-4372-a567-0e02b2c3d479" },
      ];
      const mockSql = createMockSql(rows);
      const resolve = vi.fn();

      const result = await migrateOrgs(mockSql, resolve);

      expect(result).toEqual({ success: 0, skipped: 1, failed: 0 });
      expect(resolve).not.toHaveBeenCalled();
    });

    it("counts failures when resolve returns null", async () => {
      const rows = [{ id: "aaa", org_id: "org_2fail" }];
      const mockSql = createMockSql(rows);
      const resolve = vi.fn().mockResolvedValue(null);

      const result = await migrateOrgs(mockSql, resolve);

      expect(result).toEqual({ success: 0, skipped: 0, failed: 1 });
    });

    it("handles empty table", async () => {
      const mockSql = createMockSql([]);
      const resolve = vi.fn();

      const result = await migrateOrgs(mockSql, resolve);

      expect(result).toEqual({ success: 0, skipped: 0, failed: 0 });
      expect(resolve).not.toHaveBeenCalled();
    });

    it("handles mix of already-migrated and Clerk IDs", async () => {
      const rows = [
        { id: "aaa", org_id: "f47ac10b-58cc-4372-a567-0e02b2c3d479" },
        { id: "bbb", org_id: "org_2needsfix" },
      ];
      const { sql: mockSql } = createTrackingSql(rows);
      const resolve = vi.fn().mockResolvedValue("cccc-cccc-cccc-cccc-cccccccccccc");

      const result = await migrateOrgs(mockSql, resolve);

      expect(result).toEqual({ success: 1, skipped: 1, failed: 0 });
      expect(resolve).toHaveBeenCalledTimes(1);
      expect(resolve).toHaveBeenCalledWith("org_2needsfix");
    });
  });

  describe("migrateUsers", () => {
    it("resolves Clerk user IDs and returns success count", async () => {
      const rows = [{ id: "uuu-local", user_id: "user_2abc" }];
      const { sql: mockSql } = createTrackingSql(rows);
      const resolve = vi.fn().mockResolvedValue("dddd-dddd-dddd-dddd-dddddddddddd");

      const result = await migrateUsers(mockSql, resolve);

      expect(result).toEqual({ success: 1, skipped: 0, failed: 0 });
      expect(resolve).toHaveBeenCalledWith("user_2abc");
    });

    it("skips rows that already have UUID values", async () => {
      const rows = [
        { id: "uuu", user_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890" },
      ];
      const mockSql = createMockSql(rows);
      const resolve = vi.fn();

      const result = await migrateUsers(mockSql, resolve);

      expect(result).toEqual({ success: 0, skipped: 1, failed: 0 });
      expect(resolve).not.toHaveBeenCalled();
    });

    it("counts failures when resolve returns null", async () => {
      const rows = [{ id: "uuu", user_id: "user_2fail" }];
      const mockSql = createMockSql(rows);
      const resolve = vi.fn().mockResolvedValue(null);

      const result = await migrateUsers(mockSql, resolve);

      expect(result).toEqual({ success: 0, skipped: 0, failed: 1 });
    });
  });
});
