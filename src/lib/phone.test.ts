import { describe, expect, it } from "vitest";
import { normalizePhone } from "./phone";

describe("normalizePhone", () => {
  it("keeps international numbers", () => {
    expect(normalizePhone("+1 (415) 555-0199")).toBe("+14155550199");
  });

  it("adds the default country code for 10 digit local numbers", () => {
    expect(normalizePhone("98765 43210")).toBe("+919876543210");
  });
});
