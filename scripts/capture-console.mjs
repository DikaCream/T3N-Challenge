/**
 * Capture the operator console as PNGs, for the challenge submission.
 *
 *   node scripts/capture-console.mjs [url] [outDir]
 *
 * Why not `chromium --screenshot`: that flag screenshots a fixed window size, so
 * a long page is either cropped or padded with white. This drives Chrome over the
 * DevTools Protocol instead, measures the real content height, and clips each
 * capture to an element's own box. It needs no dependency — Node's global
 * `WebSocket` is enough — which keeps `npm install` unchanged for everyone who
 * just wants to run the agent.
 *
 * Also captures one PNG per console panel, because a single very tall image is
 * unreadable when pasted into a document.
 *
 * Two panels are idle until asked (`Onboard an employee`, `Onboarding records`) —
 * they cannot know what to plan or which employee to look up. Screenshotting them
 * idle would document the empty state, so they are driven the way an operator
 * would drive them, and the result is what gets captured.
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const url = process.argv[2] ?? "http://localhost:3100/";
const outDir = process.argv[3] ?? "screenshots";
const PORT = 9222;
const VIEWPORT = { width: 1440, height: 1000 };

/**
 * Panels that need a click before they show anything. The heading is what
 * `Panel` renders as its `h2`, which is also how the output files are named, so
 * a title that changes renames the screenshot — and breaks the links in
 * `docs/SUBMISSION.md`. Keep the two in step.
 */
const DRIVERS = [
  { panel: "Onboard an employee", button: "Run dry onboarding" },
  { panel: "Onboarding records", button: "Look up" },
];

mkdirSync(outDir, { recursive: true });

const chrome = spawn(
  "chromium",
  [
    "--headless",
    "--no-sandbox",
    "--disable-gpu",
    "--hide-scrollbars",
    `--remote-debugging-port=${PORT}`,
    `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
    "about:blank",
  ],
  { stdio: "ignore" },
);

/** Poll until the DevTools endpoint answers. */
async function findTarget() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const targets = await response.json();
      const page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page !== undefined) return page.webSocketDebuggerUrl;
    } catch {
      // not up yet
    }
    await sleep(250);
  }
  throw new Error("chromium did not expose a debug target");
}

const socket = new WebSocket(await findTarget());
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});

let nextId = 1;
const pending = new Map();
const events = [];

socket.addEventListener("message", (raw) => {
  const message = JSON.parse(raw.data);
  if (message.id !== undefined) {
    const entry = pending.get(message.id);
    pending.delete(message.id);
    if (entry !== undefined) entry(message);
  } else {
    events.push(message);
  }
});

function send(method, params = {}, timeoutMs = 30_000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out`));
    }, timeoutMs);
    pending.set(id, (message) => {
      clearTimeout(timer);
      if (message.error !== undefined) reject(new Error(`${method}: ${message.error.message}`));
      else resolve(message.result);
    });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const result = await send("Runtime.evaluate", { expression, returnByValue: true });
  return result.result.value;
}

/**
 * Wait until nothing is mid-request and the layout has stopped moving.
 *
 * `AsyncBody` renders `Working…` for the loading state, so that is the signal to
 * poll. Waiting only on a stable height is not enough: a panel showing
 * `Working…` is exactly as tall as the panel that will replace it, so a
 * height-only wait can capture the spinner.
 */
async function settle() {
  for (let i = 0; i < 100; i += 1) {
    await sleep(300);
    const working = await evaluate(
      `[...document.querySelectorAll(".card")].some((el) => el.textContent.includes("Working…"))`,
    );
    if (!working) break;
  }

  let previous = -1;
  for (let i = 0; i < 40; i += 1) {
    await sleep(300);
    const height = await evaluate("document.documentElement.scrollHeight");
    if (height === previous && height > 0) return;
    previous = height;
  }
}

/** Click one button inside one panel, by heading and label. */
function click(panel, button) {
  return evaluate(`
    (() => {
      const card = [...document.querySelectorAll(".card")]
        .find((el) => (el.querySelector("h2")?.textContent ?? "").trim() === ${JSON.stringify(panel)});
      if (card === undefined) return "panel not found";
      const target = [...card.querySelectorAll("button")]
        .find((el) => el.textContent.trim().includes(${JSON.stringify(button)}));
      if (target === undefined) return "button not found";
      if (target.disabled) return "button disabled";
      target.click();
      return "clicked";
    })()
  `);
}

async function shoot(file, clip) {
  const params = { format: "png" };
  if (clip !== undefined) params.clip = { ...clip, scale: 1 };
  const { data } = await send("Page.captureScreenshot", params, 60_000);
  const path = `${outDir}/${file}`;
  writeFileSync(path, Buffer.from(data, "base64"));
  console.log(`  ${file.padEnd(42)} ${clip === undefined ? "full page" : `${clip.width}x${Math.round(clip.height)}`}`);
}

await send("Page.enable");
await send("Runtime.enable");
await send("Page.navigate", { url });

// Wait for load, then for the panels that fetch on mount to land.
for (let i = 0; i < 80; i += 1) {
  await sleep(250);
  if (events.some((e) => e.method === "Page.loadEventFired")) break;
}
await settle();

console.log("driving panels that are idle until asked:");
for (const { panel, button } of DRIVERS) {
  const outcome = await click(panel, button);
  console.log(`  ${panel.padEnd(22)} → ${button.padEnd(20)} ${outcome}`);
  if (outcome === "clicked") await settle();
}

const height = await evaluate("document.documentElement.scrollHeight");
const width = await evaluate("document.documentElement.scrollWidth");
console.log(`page is ${width}x${height}`);

// A viewport matching the content makes clip-free captures come out whole.
await send("Emulation.setDeviceMetricsOverride", {
  width,
  height,
  deviceScaleFactor: 1,
  mobile: false,
  captureBeyondViewport: true,
});

console.log("capturing:");
await shoot("14-web-console-full.png");
await shoot("14a-web-console-above-fold.png", { x: 0, y: 0, width, height: VIEWPORT.height });

// One image per panel, in document order.
const cards = await evaluate(`
  JSON.stringify([...document.querySelectorAll(".card")]
    .map((el) => {
      const r = el.getBoundingClientRect();
      const heading = el.querySelector("h2");
      return {
        name: heading ? heading.textContent.trim() : "panel",
        x: r.left + window.scrollX,
        y: r.top + window.scrollY,
        width: r.width,
        height: r.height,
      };
    })
    .filter((c) => c.width > 0 && c.height > 0))
`);

const slug = (text) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

let index = 1;
for (const card of JSON.parse(cards)) {
  await shoot(`15-${String(index).padStart(2, "0")}-${slug(card.name)}.png`, {
    x: card.x,
    y: card.y,
    width: card.width,
    height: card.height,
  });
  index += 1;
}

// A plain-text transcript of what each panel rendered. Screenshots are neither
// diffable nor greppable; this is, so a capture that shows an error state where
// it should show data is visible without opening the PNGs.
//
// The panels are serialised with JSON.stringify and unescaped out here, not
// inside the expression. A backslash in a template literal is consumed by *this*
// file's parser before Chrome ever sees it, so `\n` inside the expression above
// would silently become a real newline and break it.
const captured = JSON.parse(
  await evaluate(`
    JSON.stringify([...document.querySelectorAll(".card")].map((el) => ({
      heading: (el.querySelector("h2")?.textContent ?? "panel").trim(),
      text: el.innerText,
    })))
  `),
);

const transcript = captured
  .map(({ heading, text }) => {
    const body = text.replace(/\n{2,}/g, "\n").trim();
    return `${heading}\n${"-".repeat(heading.length)}\n${body}`;
  })
  .join("\n\n");

writeFileSync(`${outDir}/console-text.txt`, `${transcript}\n`);
console.log(`  ${"console-text.txt".padEnd(42)} ${transcript.length} chars`);

socket.close();
chrome.kill();
console.log(`\nwritten to ${outDir}/`);
