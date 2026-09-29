import { describe, expect, it } from "vitest";

import { recipeFor, registerForkParent } from "./recipes.js";

describe("recipeFor", () => {
  it("knows excalidraw itself", () => {
    expect(recipeFor("excalidraw", "excalidraw")?.repo).toBe("excalidraw/excalidraw");
  });

  it("a fork gets its parent's recipe once registered (PRs copied into the user's fork)", () => {
    expect(recipeFor("someone", "excalidraw")).toBeUndefined();
    registerForkParent("someone", "excalidraw", "excalidraw/excalidraw");
    expect(recipeFor("someone", "excalidraw")?.repo).toBe("excalidraw/excalidraw");
  });

  it("a fork of a repo without a recipe still has none", () => {
    registerForkParent("someone", "other", "nobody/other");
    expect(recipeFor("someone", "other")).toBeUndefined();
  });
});
