import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/localDb", () => ({ getProviderConnections: vi.fn() }));
vi.mock("@/app/api/usage/[connectionId]/route.js", () => ({ refreshAndUpdateCredentials: vi.fn() }));

const { pickExpiringGrant } = await import("../../src/shared/services/claudeResetAutoApply.js");

const NOW = Date.parse("2026-10-22T12:30:00Z");
const grant = (id, endsAt, extra = {}) => ({ id, endsAt, usableNow: true, paused: false, resetsLeft: 1, ...extra });

describe("pickExpiringGrant", () => {
  it("picks a usable grant expiring within the hour, soonest first", () => {
    const credits = { grants: [grant("late", "2026-10-22T13:20:00Z"), grant("soon", "2026-10-22T13:00:00Z")] };
    expect(pickExpiringGrant(credits, NOW)?.id).toBe("soon");
  });

  it("leaves grants with more than an hour left alone", () => {
    expect(pickExpiringGrant({ grants: [grant("g", "2026-10-22T13:31:00Z")] }, NOW)).toBeNull();
  });

  it("skips expired, paused, spent and not-usable-now grants", () => {
    const credits = { grants: [
      grant("expired", "2026-10-22T12:00:00Z"),
      grant("paused", "2026-10-22T13:00:00Z", { paused: true }),
      grant("spent", "2026-10-22T13:00:00Z", { resetsLeft: 0 }),
      grant("blocked", "2026-10-22T13:00:00Z", { usableNow: false }),
    ] };
    expect(pickExpiringGrant(credits, NOW)).toBeNull();
  });

  it("tolerates a connection with no reset block", () => {
    expect(pickExpiringGrant(null, NOW)).toBeNull();
  });
});
