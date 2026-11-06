#!/usr/bin/env node
/**
 * Smoke test for the deployed app, in on-chain (live) mode and mock mode.
 *
 *   E2E_BASE_URL=https://your-app.vercel.app npm run e2e:live
 *
 * Visits every page, waits two refresh cycles (30 s each by default), and fails on:
 *   - console errors or uncaught page errors
 *   - HTTP 429 responses
 *   - error banners (framework error screens, the "data may be stale" notice, wallet or transaction errors)
 *
 * Optional: E2E_CYCLE_MS (default 30000) to shorten the wait while developing.
 * First run needs a browser: npx playwright install chromium
 */
import { chromium } from "playwright";

const BASE = process.env.E2E_BASE_URL?.replace(/\/+$/, "");
if (!BASE) {
  console.error("Set E2E_BASE_URL to the production URL, for example https://your-app.vercel.app");
  process.exit(2);
}

const CYCLE_MS = Number(process.env.E2E_CYCLE_MS ?? 30_000);
const ROUTES = ["/", "/demo", "/demo/markets", "/demo/vault", "/demo/portfolio", "/demo/agents", "/demo/how-it-works"];
const MODES = [
  { name: "live", value: "onchain" },
  { name: "mock", value: "mock" },
];

/** Selectors and text that mean the user is looking at an error. */
const ERROR_SELECTORS = [
  '[data-error-banner]',
  '[data-live-status="stale"]',
  "[data-tx-error]",
  "[data-wallet-error]",
];
const ERROR_TEXT = /Application error|Unhandled Runtime Error|Something went wrong|This page could not be found/i;

const failures = [];
const fail = (mode, route, message) => failures.push(`[${mode}] ${route}: ${message}`);

const browser = await chromium.launch();
try {
  for (const mode of MODES) {
    const context = await browser.newContext();
    await context.addInitScript(
      ([key, value]) => window.localStorage.setItem(key, value),
      ["wavefund:data-mode", mode.value],
    );

    // Open every page at once, then wait two refresh cycles a single time.
    const pages = await Promise.all(
      ROUTES.map(async (route) => {
        const page = await context.newPage();
        page.on("console", (msg) => {
          if (msg.type() !== "error") return;
          const text = msg.text();
          if (/favicon/i.test(text)) return;
          fail(mode.name, route, `console error: ${text}`);
        });
        page.on("pageerror", (err) => fail(mode.name, route, `page error: ${err.message}`));
        page.on("response", (res) => {
          if (res.status() === 429) fail(mode.name, route, `429 from ${res.url()}`);
        });
        const res = await page.goto(`${BASE}${route}`, { waitUntil: "domcontentloaded" });
        if (!res || res.status() >= 400) fail(mode.name, route, `HTTP ${res?.status() ?? "no response"}`);
        return { route, page };
      }),
    );

    console.log(`[${mode.name}] opened ${pages.length} pages, waiting two refresh cycles...`);
    await pages[0].page.waitForTimeout(CYCLE_MS * 2 + 3_000);

    for (const { route, page } of pages) {
      for (const selector of ERROR_SELECTORS) {
        if ((await page.locator(selector).count()) > 0) fail(mode.name, route, `error banner: ${selector}`);
      }
      const body = await page.locator("body").innerText();
      if (ERROR_TEXT.test(body)) fail(mode.name, route, "error text on the page");
    }
    await context.close();
  }
} finally {
  await browser.close();
}

if (failures.length > 0) {
  console.error(`\n${failures.length} problem(s):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("\nOK: no console errors, 429s or error banners in live or mock mode.");
