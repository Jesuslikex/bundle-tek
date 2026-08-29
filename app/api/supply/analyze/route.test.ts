import { describe, expect, it } from "vitest";
import { POST } from "@/app/api/supply/analyze/route";

describe("POST /api/supply/analyze", () => {
  it("returns 400 for malformed JSON", async () => {
    const request = new Request("https://bundle.test/api/supply/analyze", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not-json",
    });

    const response = await POST(request);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "INVALID_JSON" });
  });
});
