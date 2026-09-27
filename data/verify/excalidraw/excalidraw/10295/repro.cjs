/**
 * Verifies that the sidebar z-index was raised above the toolbar (App-top-bar).
 *
 * Signal:
 *   --zIndex-ui-library CSS variable on :root
 *     BASE = 80  (sidebar is BELOW toolbar at z=100 → bug present)
 *     HEAD = 120 (sidebar is ABOVE toolbar at z=100 → fixed)
 *
 * Additional behavioural check via elementFromPoint:
 *   Open the sidebar, then probe a point in the top-right corner where both the
 *   sidebar and the toolbar overlap.  In BASE the toolbar element is on top; in
 *   HEAD the sidebar is on top.
 */

const { launch } = require("./pw.cjs");

async function main() {
  const url = process.argv[2];
  const pngPath = process.argv[3] || null;

  const browser = await launch();
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(url, { waitUntil: "networkidle" });

  // Wait for editor to be ready
  await page.waitForSelector(".excalidraw", { timeout: 15000 });
  await page.waitForTimeout(1500);

  // Dismiss any welcome modal
  await page.evaluate(() => {
    document.querySelectorAll(".excalidraw-modal-container").forEach((el) => el.remove());
  });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);

  // Read the CSS variable value for sidebar z-index from :root
  const libraryZIndex = await page.evaluate(() => {
    const val = getComputedStyle(document.documentElement)
      .getPropertyValue("--zIndex-ui-library")
      .trim();
    return parseInt(val, 10);
  });

  const topBarZIndex = await page.evaluate(() => {
    const val = getComputedStyle(document.documentElement)
      .getPropertyValue("--zIndex-ui-top")
      .trim();
    return parseInt(val, 10);
  });

  // Open the sidebar (library) by clicking its trigger button
  let sidebarOpened = false;
  try {
    // The sidebar trigger is a checkbox-based label with aria-label="Library"
    const trigger = page.locator('input[aria-label="Library"]');
    const triggerCount = await trigger.count();
    if (triggerCount > 0) {
      await trigger.click({ force: true });
      await page.waitForTimeout(800);
      sidebarOpened = true;
    }
  } catch (e) {
    // fallback: skip elementFromPoint check
  }

  // If sidebar is open, do a behavioural stacking check.
  // The sidebar occupies the right edge; the toolbar/top-bar sits in the top-right.
  // We probe a point that is inside both: roughly top=80, x=1200 (top-right overlap area).
  let topElementIsToolbar = null;
  let topElementIsSidebar = null;

  if (sidebarOpened) {
    const result = await page.evaluate(() => {
      // Find the sidebar element and the App-top-bar / FixedSideContainer element
      const sidebar = document.querySelector(".excalidraw .sidebar");
      if (!sidebar) return null;

      const sidebarRect = sidebar.getBoundingClientRect();
      // Pick a point near the top of the sidebar (which overlaps with the top-bar)
      const probeX = sidebarRect.left + 20;
      const probeY = sidebarRect.top + 20;

      const el = document.elementFromPoint(probeX, probeY);
      if (!el) return null;

      const isInsideSidebar = sidebar.contains(el);
      // Check if the element is inside the fixed side container / top-bar
      const isInsideTopBar =
        !!el.closest(".App-top-bar") ||
        !!el.closest(".layer-ui__wrapper__top-right") ||
        !!el.closest(".FixedSideContainer");

      return { isInsideSidebar, isInsideTopBar, tagName: el.tagName, className: (el.className || "").slice(0, 80), probeX, probeY };
    });

    if (result) {
      topElementIsSidebar = result.isInsideSidebar;
      topElementIsToolbar = result.isInsideTopBar;
    }
  }

  // Bug is present when the library z-index <= top-bar z-index
  // BASE: libraryZIndex=80, topBarZIndex=100 → bugPresent=true
  // HEAD: libraryZIndex=120, topBarZIndex=100 → bugPresent=false
  const bugPresent = libraryZIndex <= topBarZIndex;

  // Also check: data-prevent-outside-click attribute on the dropdown menu button
  // BASE has it; HEAD removed it. This is an additional corroborating signal.
  const hasPreventAttr = await page.evaluate(() => {
    const btn = document.querySelector('[data-testid="dropdown-menu-button"]');
    return btn ? btn.hasAttribute("data-prevent-outside-click") : null;
  });

  // Highlights
  let highlights = [];
  if (pngPath) {
    const vw = 1280;
    const vh = 800;
    // Highlight the sidebar z-index area — the right panel
    const sidebarBox = await page.evaluate(() => {
      const el = document.querySelector(".excalidraw .sidebar");
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height };
    });

    // Highlight the top-right toolbar area
    const topRightBox = await page.evaluate(() => {
      const el = document.querySelector(".layer-ui__wrapper__top-right");
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height };
    });

    if (sidebarBox) {
      highlights.push({
        x: sidebarBox.x / vw,
        y: sidebarBox.y / vh,
        w: sidebarBox.w / vw,
        h: Math.min(sidebarBox.h / vh, 0.3), // just the top portion
        label: bugPresent
          ? `Sidebar z-index=${libraryZIndex} < toolbar z-index=${topBarZIndex} (bug: toolbar covers sidebar)`
          : `Sidebar z-index=${libraryZIndex} > toolbar z-index=${topBarZIndex} (fixed: sidebar above toolbar)`,
        pair: "sidebar",
      });
    }

    if (topRightBox) {
      highlights.push({
        x: topRightBox.x / vw,
        y: topRightBox.y / vh,
        w: topRightBox.w / vw,
        h: topRightBox.h / vh,
        label: bugPresent
          ? `Top-right toolbar (z=${topBarZIndex}) sits above sidebar (z=${libraryZIndex})`
          : `Top-right toolbar (z=${topBarZIndex}) now below sidebar (z=${libraryZIndex})`,
        pair: "toolbar",
      });
    }

    await page.screenshot({ path: pngPath });
  }

  await browser.close();

  const output = {
    bugPresent,
    measure: {
      libraryZIndex,
      topBarZIndex,
      sidebarBelowToolbar: bugPresent,
      topElementIsSidebar,
      topElementIsToolbar,
      hasPreventOutsideClickAttr: hasPreventAttr,
    },
    highlights,
  };

  process.stdout.write(JSON.stringify(output) + "\n");
}

main().catch((err) => {
  process.stderr.write(String(err) + "\n");
  process.exit(1);
});
