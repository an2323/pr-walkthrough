/**
 * symptom-0: Top-right toolbar sits above the open sidebar (z-index stacking).
 * Shows the sidebar open with the top-right area highlighted where the toolbar
 * would appear above the sidebar in BASE.
 *
 * Signal: --zIndex-ui-library CSS var < --zIndex-ui-top → toolbar is above sidebar
 */

const { launch } = require("./pw.cjs");

async function main() {
  const url = process.argv[2];
  const pngPath = process.argv[3] || null;

  const browser = await launch();
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1280, height: 800 });
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
  await trigger.click({ force: true });
  await page.waitForTimeout(800);

  // Read z-index values
  const libraryZIndex = await page.evaluate(() =>
    parseInt(getComputedStyle(document.documentElement).getPropertyValue("--zIndex-ui-library").trim(), 10)
  );
  const topBarZIndex = await page.evaluate(() =>
    parseInt(getComputedStyle(document.documentElement).getPropertyValue("--zIndex-ui-top").trim(), 10)
  );

  const bugPresent = libraryZIndex < topBarZIndex;

  let highlights = [];
  const vw = 1280;
  const vh = 800;

  // Sidebar box
  const sidebarBox = await page.evaluate(() => {
    const el = document.querySelector(".excalidraw .sidebar");
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  });

  // Top-right toolbar box
  const toolbarBox = await page.evaluate(() => {
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
      h: 0.12,
      label: bugPresent
        ? `Sidebar z-index=${libraryZIndex} (BELOW toolbar z-index=${topBarZIndex})`
        : `Sidebar z-index=${libraryZIndex} (ABOVE toolbar z-index=${topBarZIndex}, fixed)`,
      pair: "sidebar-top",
    });
  }

  if (toolbarBox) {
    highlights.push({
      x: toolbarBox.x / vw,
      y: toolbarBox.y / vh,
      w: toolbarBox.w / vw,
      h: toolbarBox.h / vh,
      label: bugPresent
        ? `Toolbar z-index=${topBarZIndex} — floats ABOVE sidebar`
        : `Toolbar z-index=${topBarZIndex} — now under sidebar`,
      pair: "toolbar",
    });
  }

  if (pngPath) {
    await page.screenshot({ path: pngPath });
  }

  await browser.close();

  process.stdout.write(JSON.stringify({ ok: bugPresent, highlights }) + "\n");
}

main().catch((err) => {
  process.stderr.write(String(err) + "\n");
  process.exit(1);
});
