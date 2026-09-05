import { describe, expect, it } from "vitest";
import { verifyAdminToken, getExpectedAdminToken } from "@/security/auth";

describe("security/auth — verifyAdminToken", () => {
  it("validates correct x-agentguard-admin-token header", () => {
    const expected = getExpectedAdminToken();
    const req = new Request("http://localhost:3000/api/agentguard/reset", {
      method: "POST",
      headers: {
        "x-agentguard-admin-token": expected,
      },
    });

    expect(verifyAdminToken(req)).toBe(true);
  });

  it("rejects request missing x-agentguard-admin-token header", () => {
    const req = new Request("http://localhost:3000/api/agentguard/reset", {
      method: "POST",
    });

    expect(verifyAdminToken(req)).toBe(false);
  });

  it("rejects request with invalid token", () => {
    const req = new Request("http://localhost:3000/api/agentguard/reset", {
      method: "POST",
      headers: {
        "x-agentguard-admin-token": "wrong-token-12345",
      },
    });

    expect(verifyAdminToken(req)).toBe(false);
  });

  it("rejects request with token of different length", () => {
    const req = new Request("http://localhost:3000/api/agentguard/reset", {
      method: "POST",
      headers: {
        "x-agentguard-admin-token": "short",
      },
    });

    expect(verifyAdminToken(req)).toBe(false);
  });
});
