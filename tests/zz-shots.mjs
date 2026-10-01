// Temporary screenshot helper (deleted after use).
import { chromium } from "@playwright/test";
const OUT = "/private/tmp/claude-501/-Users-tatemccormick-Documents-Projects-yard-projects-yard-keyring/d1fca908-9e4f-4ac8-8b20-17cf3ac50b20/scratchpad/shots/";
const B = "http://localhost:9875/keyring/app/";
const P = "42205e39-8cea-4ff4-bf37-a94e3b56231a", U = "64c0556a-2c84-4c70-995e-259beca56bd4";
const L = "89b2d6dd-2d53-42c8-81c9-438653f64a29", T = "2bc9b30f-5255-4181-b87c-4f1877775dc8";
const only = process.argv[2];
const pages = [
  ["l-props", "user:landlord", "#/l"],
  ["l-roll", "user:landlord", `#/l/p/${P}`],
  ["l-unit", "user:landlord", `#/l/p/${P}/u/${U}`],
  ["l-unit-vacant", "user:landlord", `#/l/p/${P}/u/7998d9fc-0e39-45e0-9444-13c28913cfdc`],
  ["l-reqs", "user:landlord", `#/l/p/${P}/requests`],
  ["l-notices", "user:landlord", `#/l/p/${P}/notices`],
  ["l-dialog", "user:landlord", "#/l", async (p) => { await p.getByRole("button", { name: "New property" }).first().click(); await p.waitForTimeout(400); }],
  ["t-home", "signed-in", `#/t/${L}`],
  ["t-ticket", "signed-in", `#/t/${L}/requests/${T}`],
  ["t-newreq", "signed-in", `#/t/${L}/requests/new`],
  ["t-pay", "signed-in", `#/t/${L}`, async (p) => { await p.getByRole("button", { name: /^Pay/ }).first().click(); await p.waitForTimeout(500); }],
  ["welcome", "member", "#/welcome"],
];
const browser = await chromium.launch();
for (const scheme of ["light", "dark"]) for (const [vw, vh, tag] of [[1280, 900, "d"], [390, 844, "m"]]) {
  for (const [name, who, hash, act] of pages) {
    if (only && !name.startsWith(only)) continue;
    const ctx = await browser.newContext({ viewport: { width: vw, height: vh }, colorScheme: scheme, deviceScaleFactor: tag === "m" ? 2 : 1 });
    await ctx.addCookies([{ name: "yard_dev_identity", value: who, domain: "localhost", path: "/" }]);
    const p = await ctx.newPage();
    p.on("pageerror", (e) => console.log("pageerror", name, e.message));
    await p.goto(B + hash);
    await p.waitForTimeout(1200);
    if (act) await act(p);
    const sw = await p.evaluate(() => document.documentElement.scrollWidth);
    if (sw > vw) console.log("OVERFLOW", name, scheme, tag, sw);
    await p.screenshot({ path: `${OUT}${name}-${scheme}-${tag}.png`, fullPage: !act });
    await ctx.close();
  }
}
await browser.close();
console.log("ok");
