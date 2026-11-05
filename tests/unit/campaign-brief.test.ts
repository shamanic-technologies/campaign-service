import { describe, expect, it } from "vitest";
import { foldInstructionIntoBrief } from "../../src/lib/campaign-brief.js";

describe("foldInstructionIntoBrief (ONE-BRIEF-1105)", () => {
  it("keeps the brief first and appends the instruction as its own paragraph", () => {
    expect(foldInstructionIntoBrief("Cold email only.", "Name the price: $25,000.")).toBe("Cold email only.\n\nName the price: $25,000.");
  });
  it("no brief (null or blank) = the instruction becomes the brief", () => {
    expect(foldInstructionIntoBrief(null, "Be short.")).toBe("Be short.");
    expect(foldInstructionIntoBrief("  ", "Be short.")).toBe("Be short.");
  });
  it("is idempotent: a brief already holding the instruction is left as is", () => {
    const once = foldInstructionIntoBrief("Cold email only.", "Be short.");
    expect(foldInstructionIntoBrief(once, "Be short.")).toBe(once);
  });
  it("no instruction (null, blank) leaves the brief untouched", () => {
    expect(foldInstructionIntoBrief("Cold email only.", null)).toBe("Cold email only.");
    expect(foldInstructionIntoBrief(null, " ")).toBeNull();
  });
});
