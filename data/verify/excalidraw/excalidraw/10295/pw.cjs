// Written by the backend: Playwright from the walkthrough server, launch already verified.
const { chromium } = require("/Users/andrii/projects/ai-review-walkthrough-2026/node_modules/.pnpm/playwright@1.63.0/node_modules/playwright/index.js");
exports.chromium = chromium;
exports.launch = (opts = {}) => chromium.launch({ headless: true, ...opts });
