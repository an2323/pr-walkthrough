/**
 * repro.cjs — Arrowhead picker stays inside the screen
 *
 * Signal: In BASE the `.picker` class lives on an inner <div> that is
 * `position:absolute` inside the Radix Popover.Content wrapper, so Radix
 * does not measure the visible box for collision avoidance.
 * In HEAD the `.picker` class is applied directly to the Popover.Content
 * element (the inner wrapper div is gone), so Radix measures the correct
 * element and nudges it back into view.
 *
 * Concrete DOM signal: look for a `.picker` element whose computed
 * `position` is `absolute`.  That means the bug is present (BASE).
 * When fixed (HEAD) `.picker` has `position: relative` or `static`
 * (no absolute positioning).
 *
 * Usage: node repro.cjs <url> [pngPath]
 */

"use strict";

const { launch } = require("./pw.cjs");

(async () => {
  const url = process.argv[2];
  const pngPath = process.argv[3] || null;

  const browser = await launch();
  const page = await browser.newPage();

  // Use a 1280×800 viewport — standard desktop, the picker overflows on
  // the right edge when the trigger is near the right side of the panel.
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });

  // Wait for the canvas
  await page.waitForSelector(".excalidraw", { timeout: 15000 });
  await page.waitForTimeout(1000);

  // Dismiss any welcome modal
  await page.evaluate(() => {
    document
      .querySelectorAll(".excalidraw-modal-container")
      .forEach((el) => el.remove());
  });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);

  // ----- Step 1: Select the Arrow tool -----
  // The arrow tool button usually has data-testid="toolbar-arrow" or title containing "Arrow"
  const arrowButton = page.locator(
    '[data-testid="toolbar-arrow"], [title*="Arrow"i], [aria-label*="Arrow"i]',
  ).first();
  await arrowButton.click({ timeout: 10000 });
  await page.waitForTimeout(300);

  // ----- Step 2: Draw an arrow on the canvas -----
  // Draw near the right side of the canvas so when the right panel appears
  // the arrowhead picker trigger is near the right edge.
  const canvas = page.locator(".excalidraw canvas").first();
  const canvasBox = await canvas.boundingBox();
  if (!canvasBox) throw new Error("Canvas not found");

  // Draw an arrow roughly in the center-right area
  const startX = canvasBox.x + canvasBox.width * 0.5;
  const startY = canvasBox.y + canvasBox.height * 0.5;
  const endX = startX + 120;
  const endY = startY;

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(endX, endY, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(600);

  // ----- Step 3: Ensure the arrow is selected and the side panel is visible -----
  // The side panel should appear automatically after drawing.
  // Wait for the arrowhead picker trigger to appear.
  await page.waitForSelector(
    '[aria-label="arrowhead_start"], [aria-label="arrowhead_end"]',
    { timeout: 10000 },
  );
  await page.waitForTimeout(300);

  // ----- Step 4: Open the arrowhead picker (end arrowhead) -----
  const endPickerTrigger = page.locator('[aria-label="arrowhead_end"]').first();
  await endPickerTrigger.click({ timeout: 10000 });
  await page.waitForTimeout(600);

  // ----- Step 5: Measure the signal -----
  // Wait for the picker popup to appear
  await page.waitForSelector(".picker", { timeout: 10000 });

  // Determine the DOM structure:
  // BASE: Popover.Content has no "picker" class; inner child div has it,
  //       and that inner div has position:absolute.
  // HEAD: Popover.Content itself has "picker" class; no inner wrapper div.
  const measure = await page.evaluate(() => {
    const pickerEl = document.querySelector(".picker");
    if (!pickerEl) return { found: false, position: null, hasInnerPickerDiv: null, isRadixContent: null };

    const computedPos = window.getComputedStyle(pickerEl).position;

    // In BASE, the .picker div is nested inside a Radix wrapper
    // (which has data-radix-popper-content-wrapper or similar attribute).
    // The Radix content element itself does NOT have class="picker" in BASE.
    const parent = pickerEl.parentElement;
    const parentIsRadixContent = parent
      ? parent.hasAttribute("data-radix-popper-content-wrapper") ||
        parent.hasAttribute("data-side") ||
        (parent.getAttribute("role") === null && !parent.classList.contains("picker"))
      : false;

    // More reliable: check if pickerEl itself has data-side (Radix sets this on Content)
    // HEAD: .picker IS the Popover.Content, so it will have data-side
    // BASE: .picker is an inner div, does NOT have data-side
    const pickerHasDataSide = pickerEl.hasAttribute("data-side");

    // Also measure bounding box vs viewport for overflow check
    const rect = pickerEl.getBoundingClientRect();
    const vpWidth = window.innerWidth;
    const vpHeight = window.innerHeight;
    const overflowsRight = rect.right > vpWidth;
    const overflowsBottom = rect.bottom > vpHeight;

    return {
      found: true,
      position: computedPos,
      pickerHasDataSide,
      rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
      vpWidth,
      vpHeight,
      overflowsRight,
      overflowsBottom,
    };
  });

  // Bug is present when:
  // BASE: .picker does NOT have data-side (it's an inner div, not the Radix element)
  // HEAD: .picker DOES have data-side (it IS the Radix Popover.Content element)
  const bugPresent = measure.found && !measure.pickerHasDataSide;

  // Compute highlight boxes
  let highlights = [];
  if (pngPath && measure.found && measure.rect) {
    const vw = measure.vpWidth;
    const vh = measure.vpHeight;
    const r = measure.rect;

    // Clamp to [0,1]
    const clamp = (v) => Math.max(0, Math.min(1, v));

    highlights = [
      {
        x: clamp(r.left / vw),
        y: clamp(r.top / vh),
        w: clamp((r.right - r.left) / vw),
        h: clamp((r.bottom - r.top) / vh),
        label: bugPresent
          ? "picker div is absolute-positioned inner element (not Radix-measured)"
          : "picker is directly on Radix element (collision avoidance works)",
        pair: "picker-popup",
      },
    ];
  }

  if (pngPath) {
    await page.screenshot({ path: pngPath, fullPage: false });
  }

  await browser.close();

  const result = { bugPresent, measure, highlights };
  process.stdout.write(JSON.stringify(result) + "\n");
})();
