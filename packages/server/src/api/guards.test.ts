import { afterEach, describe, expect, it } from "vitest";

import { adminKeyOk } from "./guards.js";

const req = (body: unknown, headers: Record<string, string> = {}) => ({
  body: body as { accessCode?: unknown },
  header: (n: string) => headers[n.toLowerCase()],
});

afterEach(() => {
  delete process.env.ACCESS_CODE;
});

describe("adminKeyOk — the key that guards force re-runs and rehearsals", () => {
  it("refuses everything when no key is configured (nobody can overwrite a walkthrough)", () => {
    expect(adminKeyOk(req({ accessCode: "anything" }))).toBe(false);
    expect(adminKeyOk(req({}))).toBe(false);
  });

  it("accepts the key from the body or from the x-access-code header, and only that", () => {
    process.env.ACCESS_CODE = "s3cret";
    expect(adminKeyOk(req({ accessCode: "s3cret" }))).toBe(true);
    expect(adminKeyOk(req({}, { "x-access-code": "s3cret" }))).toBe(true);
    expect(adminKeyOk(req({ accessCode: "s3cret " }))).toBe(true); // trimmed
    expect(adminKeyOk(req({ accessCode: "wrong" }))).toBe(false);
    expect(adminKeyOk(req({}))).toBe(false);
    expect(adminKeyOk(req({ accessCode: 12345 }))).toBe(false);
  });
});
