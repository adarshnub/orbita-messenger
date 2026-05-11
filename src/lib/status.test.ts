import { describe, expect, it } from "vitest";
import { isStatusActive, statusExpiresAt } from "./status";

describe("status expiry", () => {
  it("expires statuses after 24 hours", () => {
    const createdAt = new Date("2026-05-11T10:00:00.000Z");
    expect(statusExpiresAt(createdAt)).toBe("2026-05-12T10:00:00.000Z");
  });

  it("detects active statuses", () => {
    expect(
      isStatusActive(
        {
          id: "s1",
          authorId: "u1",
          kind: "text",
          text: "hello",
          createdAt: "2026-05-11T10:00:00.000Z",
          expiresAt: "2026-05-12T10:00:00.000Z",
          viewedBy: [],
          visibility: "contacts",
        },
        new Date("2026-05-11T11:00:00.000Z"),
      ),
    ).toBe(true);
  });
});
