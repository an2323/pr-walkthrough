import { afterEach, describe, expect, it } from "vitest";

import { corsAllowed } from "./cors.js";

const LIST = "https://pr-walkthrough-bob.vercel.app,https://pr-walkthrough-*-andriis-projects-4c05ce44.vercel.app";

describe("corsAllowed", () => {
  afterEach(() => delete process.env.CORS_ORIGINS);

  it("allows the judges' domain and this project's Vercel previews", () => {
    process.env.CORS_ORIGINS = LIST;
    expect(corsAllowed("https://pr-walkthrough-bob.vercel.app")).toBe(true);
    expect(corsAllowed("https://pr-walkthrough-2ihiqgfpm-andriis-projects-4c05ce44.vercel.app")).toBe(true);
    expect(corsAllowed("https://pr-walkthrough-git-live-backend-andriis-projects-4c05ce44.vercel.app")).toBe(true);
  });

  it("refuses other sites, including look-alikes", () => {
    process.env.CORS_ORIGINS = LIST;
    expect(corsAllowed("https://evil.example")).toBe(false);
    expect(corsAllowed("https://pr-walkthrough-x-andriis-projects-4c05ce44.vercel.app.evil.example")).toBe(false);
    expect(corsAllowed("https://pr-walkthrough-a.b-andriis-projects-4c05ce44.vercel.app")).toBe(false);
    expect(corsAllowed("https://pr-walkthrough-bob.vercel.app.evil.example")).toBe(false);
  });

  it("localhost always; nothing else without the setting", () => {
    expect(corsAllowed("http://localhost:5173")).toBe(true);
    expect(corsAllowed("https://pr-walkthrough-bob.vercel.app")).toBe(false);
  });
});
