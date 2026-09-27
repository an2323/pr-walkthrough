/**
 * symptom-1: On mobile, opening the main menu leaves the sidebar covering it.
 * Mobile viewport 390×844.
 *
 * Scenario:
 *   1. Open sidebar (library)
 *   2. Click the dropdown menu button (hamburger)
 *   3. Check if the menu content is visible above the sidebar, or hidden behind it.
 *
 * Signal (BASE): The dropdown menu button has data-prevent-outside-click,
 *   so the sidebar stays open behind the menu → the sidebar covers the menu.
 *   We check by seeing if the sidebar element is still open AND the menu is open.
 *   Then we probe: does the sidebar's z-index exceed the dropdown z-index?
 *
 * Actually the simplest signal for mobile: open sidebar, click menu button —
 * in BASE both are open simultaneously (sidebar covers menu).
 * In HEAD the sidebar closes when menu button is clicked (outside-click fires).
 */

const { launch } = require("./pw.cjs");

async function main() {
  const url = process.argv[2];
  const pngPath = process.argv[3] || null;

  const browser = await launch();
  const page = await browser.newPage();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(url, { waitUntil: "networkidle" });

  await page.waitForSelector(".excalidraw", { timeout: 15000 });
  await page.waitForTimeout(1500);

  // Dismiss welcome modal
  await page.evaluate(() => {
    document.querySelectorAll(".excalidraw-modal-container").forEach((el) => el.remove());
  });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);

  // Open the sidebar
  const trigger = page.locator('input[aria-label="Library"]');
  const triggerCount = await trigger.count();
  if (triggerCount === 0) {
    await browser.close();
    process.stdout.write(JSON.stringify({ ok: false, highlights: [], error: "No library trigger found" }) + "\n");
    return;
  }
  await trigger.click({ force: true });
  await page.waitForTimeout(800);

  // Click the main menu (hamburger) trigger button
  const menuBtn = page.locator('[data-testid="main-menu-trigger"]');
  await menuBtn.click();
  await page.waitForTimeout(800);

  // Check if sidebar is still open (bug in BASE: sidebar stays open behind menu)
  const sidebarOpen = await page.evaluate(() => {
    return !!document.querySelector(".excalidraw .sidebar");
  });

  // Check if menu content is visible
  const menuOpen = await page.evaluate(() => {
    return !!document.querySelector(".dropdown-menu");
  });

  // In BASE: both sidebarOpen and menuOpen are true (sidebar covers menu = bug)
  // In HEAD: sidebarOpen is false (sidebar closed when menu was clicked = fixed)
  const bugPresent = sidebarOpen && menuOpen;

  let highlights = [];
  const vw = 390;
  const vh = 844;

  if (pngPath) {
    const sidebarBox = await page.evaluate(() => {
      const el = document.querySelector(".excalidraw .sidebar");
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height };
    });

    const menuBox = await page.evaluate(() => {
      const el = document.querySelector(".dropdown-menu");
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height };
    });

    if (sidebarBox) {
      highlights.push({
        x: sidebarBox.x / vw,
        y: sidebarBox.y / vh,
        w: sidebarBox.w / vw,
        h: Math.min(sidebarBox.h / vh, 0.5),
        label: bugPresent
          ? "Sidebar still open — covering main menu (bug)"
          : "Sidebar closed when menu button clicked (fixed)",
        pair: "sidebar",
      });
    }

    if (menuBox) {
      highlights.push({
        x: menuBox.x / vw,
        y: menuBox.y / vh,
        w: menuBox.w / vw,
        h: Math.min(menuBox.h / vh, 0.5),
        label: bugPresent
          ? "Menu open but hidden behind sidebar"
          : "Menu fully visible (sidebar closed)",
        pair: "menu",
      });
    }

    await page.screenshot({ path: pngPath });
  }

  await browser.close();

  process.stdout.write(JSON.stringify({ ok: bugPresent, highlights }) + "\n");
}

main().catch((err) => {
  process.stderr.write(String(err) + "\n");
  process.exit(1);
});
