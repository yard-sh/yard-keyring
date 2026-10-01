import { chromium } from "@playwright/test";
const b = await chromium.launch(); const ctx = await b.newContext({ viewport: { width: 390, height: 844 } });
await ctx.addCookies([{ name: "yard_dev_identity", value: "user:landlord", domain: "localhost", path: "/" }]);
const p = await ctx.newPage();
await p.goto("http://localhost:9875/keyring/app/#/l/p/42205e39-8cea-4ff4-bf37-a94e3b56231a/u/7998d9fc-0e39-45e0-9444-13c28913cfdc");
await p.waitForTimeout(1200);
console.log(await p.evaluate(() => { const e=document.querySelector(".money-input .input"); const cs=getComputedStyle(e); return [cs.width,cs.boxSizing,cs.paddingLeft,cs.paddingRight,e.outerHTML, [...document.styleSheets].filter(s=>s.href && s.href.includes("styles.css")).flatMap(s=>[...s.cssRules]).filter(r=>r.selectorText && e.matches(r.selectorText)).map(r=>r.cssText.slice(0,160))]; }));
await b.close();
