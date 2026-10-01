// Small DOM helpers shared by every view. Text always goes in as text nodes
// or textContent: names, titles, notes and addresses come from other people.

export const $ = (id) => document.getElementById(id);

// h("button.btn.btn--primary", { type: "button", onclick }, "Pay") builds an
// element. Strings among the children become text nodes, never HTML.
export function h(tag, props, ...kids) {
  const [name, ...classes] = tag.split(".");
  const node = document.createElement(name || "div");
  if (classes.length) node.className = classes.join(" ");
  for (const [key, value] of Object.entries(props || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "text") node.textContent = value;
    else if (key === "class") node.className = (node.className + " " + value).trim();
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key === "style") for (const [prop, v] of Object.entries(value)) node.style.setProperty(prop, v);
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value);
    else if (key === "value" || key === "checked" || key === "selected") node[key] = value;
    else node.setAttribute(key, value === true ? "" : value);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    node.append(kid instanceof Node ? kid : String(kid));
  }
  return node;
}

export function icon(name, className = "icon") {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", className);
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", "#i-" + name);
  svg.append(use);
  return svg;
}

// A unit number on a key tag: the one shape Keyring repeats everywhere. The
// punched hole is drawn by the stylesheet, see-through on any background.
export function keyTag(number, size) {
  return h(
    "span.keytag" + (size ? ".keytag--" + size : ""),
    { title: "Unit " + number },
    h("span.keytag__num", {}, number),
  );
}

/* ------------------------------------------------------------- storage */

export const store = {
  get(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch {
      // Private mode or blocked storage: preferences just don't stick.
    }
  },
};

/* --------------------------------------------------------------- money */

const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

export function money(cents) {
  return USD.format((cents || 0) / 100);
}

// "1,850.5" → 185050. String arithmetic, so no float ever touches a cent.
export function parseMoney(text) {
  const clean = String(text || "").replace(/[$,\s]/g, "");
  const m = /^(\d{1,7})(?:\.(\d{0,2}))?$/.exec(clean);
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] || "").padEnd(2, "0"));
}

export function centsToInput(cents) {
  return ((cents || 0) / 100).toFixed(2);
}

/* ---------------------------------------------------------------- time */

// Every calendar date Keyring stores is UTC midnight, so it is shown in UTC
// too; in local time a due date would slip to the day before in the Americas.
const DAY = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const DATE = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const MONTH = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
const MONTH_SHORT = new Intl.DateTimeFormat("en-US", { month: "long", timeZone: "UTC" });

export function fmtDay(ms) {
  return ms ? DAY.format(ms) : "";
}

export function fmtDate(ms) {
  return ms ? DATE.format(ms) : "";
}

// "2026-11" → "November 2026" (or just "November" with short).
export function fmtMonth(key, short) {
  const [y, m] = String(key).split("-").map(Number);
  const ms = Date.UTC(y, m - 1, 1);
  return (short ? MONTH_SHORT : MONTH).format(ms);
}

export function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

export function isoDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

export function nextMonthKey() {
  const d = new Date();
  const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
  return next.toISOString().slice(0, 7);
}

// A moment, not a calendar date: shown relative, in local time.
export function ago(ms) {
  if (!ms) return "";
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return Math.round(s / 60) + "m ago";
  if (s < 86400) return Math.round(s / 3600) + "h ago";
  if (s < 2 * 86400) return "yesterday";
  if (s < 7 * 86400) return Math.round(s / 86400) + "d ago";
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function plural(n, word, many) {
  return n + " " + (n === 1 ? word : many || word + "s");
}

// What a view compares before repainting: everything but the clock, since
// as_of changes on every read.
export function signature(value) {
  return JSON.stringify(value, (key, v) => (key === "as_of" ? undefined : v));
}

/* ------------------------------------------------------------- people */

// Six calm colours for people's initials; the same person always gets the
// same one.
const PEOPLE = ["#1F3A93", "#0B6FB8", "#0F7A4D", "#B4462F", "#5B3FA0", "#8A5A00"];

export function colorOf(id) {
  let hash = 0;
  for (const ch of String(id || "")) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return PEOPLE[hash % PEOPLE.length];
}

export function avatar(name, id, size) {
  const first =
    String(name || "")
      .trim()
      .charAt(0)
      .toUpperCase() || "?";
  return h(
    "span.avatar" + (size ? ".avatar--" + size : ""),
    { style: { "--c": colorOf(id || name) }, title: name || "" },
    first,
  );
}

/* -------------------------------------------------------------- status */

export const STATUS_LABEL = {
  submitted: "Submitted",
  acknowledged: "Acknowledged",
  in_progress: "In progress",
  resolved: "Resolved",
  paid: "Paid",
  open: "Due",
  overdue: "Overdue",
};

export function pill(status, text) {
  return h("span.pill.pill--" + status, {}, text || STATUS_LABEL[status] || status);
}

export const CATEGORIES = {
  plumbing: { label: "Plumbing", icon: "drop" },
  electrical: { label: "Electrical", icon: "bolt" },
  appliance: { label: "Appliance", icon: "fridge" },
  heating: { label: "Heating & cooling", icon: "flame" },
  pest: { label: "Pests", icon: "bug" },
  other: { label: "Something else", icon: "wrench" },
};

// Paragraphs and bare links, built from text: announcement and request
// bodies never become HTML.
export function prose(text) {
  const wrap = h("div.prose");
  for (const para of String(text || "").split(/\n{2,}/)) {
    const p = h("p");
    const lines = para.split("\n");
    lines.forEach((line, i) => {
      for (const part of line.split(/(https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"])/g)) {
        if (/^https?:\/\//.test(part))
          p.append(h("a", { href: part, target: "_blank", rel: "noopener noreferrer" }, part));
        else if (part) p.append(part);
      }
      if (i < lines.length - 1) p.append(h("br"));
    });
    wrap.append(p);
  }
  return wrap;
}

/* --------------------------------------------------------------- toast */

let toastTimer = 0;

export function toast(message, tone) {
  const node = $("toast");
  node.textContent = message;
  node.dataset.tone = tone || "";
  node.hidden = false;
  // Restart the entrance animation for back-to-back toasts.
  node.style.animation = "none";
  void node.offsetWidth;
  node.style.animation = "";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (node.hidden = true), tone === "error" ? 4600 : 3200);
}

/* --------------------------------------------------------------- modal */

// Every dialog is built when it opens and removed when it closes. onSubmit
// may throw: its message shows inside the dialog and the dialog stays open.
// Resolves with whatever onSubmit returned, or null when dismissed.
export function modal({
  title,
  content,
  confirm = "Save",
  cancel = "Cancel",
  danger = false,
  onSubmit,
  wide = false,
  onOpen,
}) {
  return new Promise((resolve) => {
    let settled = false;
    const error = h("p.modal__error", { role: "alert", hidden: true });
    const ok = h("button.btn." + (danger ? "btn--danger" : "btn--primary"), { type: "submit" }, confirm);
    const close = h("button.iconbtn.modal__x", { type: "button", "aria-label": "Close" }, icon("x"));
    const form = h(
      "form.modal__form",
      { method: "dialog", novalidate: true },
      h("header.modal__head", {}, h("h2.modal__title", {}, title), close),
      h("div.modal__body", {}, content),
      error,
      h(
        "footer.modal__foot",
        {},
        cancel ? h("button.btn.btn--ghost", { type: "button", onclick: () => dialog.close() }, cancel) : null,
        confirm ? ok : null,
      ),
    );
    const dialog = h("dialog.modal" + (wide ? ".modal--wide" : ""), {}, form);
    close.addEventListener("click", () => dialog.close());

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      error.hidden = true;
      if (!onSubmit) return finish(true);
      busy(ok, true);
      try {
        const result = await onSubmit(form);
        if (result === false) return;
        finish(result === undefined ? true : result);
      } catch (err) {
        error.textContent = (err && err.message) || "Something went wrong.";
        error.hidden = false;
      } finally {
        busy(ok, false);
      }
    });
    dialog.addEventListener("close", () => {
      dialog.remove();
      if (!settled) resolve(null);
      settled = true;
    });

    function finish(value) {
      settled = true;
      resolve(value);
      dialog.close();
    }

    document.body.append(dialog);
    dialog.showModal();
    const first = form.querySelector("input:not([type=hidden]):not([type=checkbox]), textarea, select");
    if (first) first.focus();
    else ok.focus();
    if (onOpen) onOpen(dialog, form);
  });
}

export async function confirmModal({ title, body, confirm = "OK", danger = false }) {
  return !!(await modal({ title, content: h("p.modal__text", {}, body), confirm, danger }));
}

export function busy(button, on) {
  if (!button) return;
  button.disabled = on;
  button.classList.toggle("is-busy", on);
}

/* ---------------------------------------------------------------- form */

// A labelled field. The input keeps its name, so a form's values read back
// with form.elements[name].
export function field(label, input, hint) {
  return h("label.field", {}, h("span.field__label", {}, label), input, hint ? h("span.field__hint", {}, hint) : null);
}

export function input(name, props = {}) {
  return h("input.input", { name, autocomplete: "off", ...props });
}

export function textarea(name, props = {}) {
  return h("textarea.input.input--area", { name, ...props });
}

export function select(name, options, value) {
  return h(
    "select.input",
    { name },
    options.map(([v, label]) => h("option", { value: v, selected: v === value }, label)),
  );
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Clipboard blocked (http, or permissions): select a hidden field instead.
    const area = h("textarea", { style: { position: "fixed", opacity: "0" } });
    area.value = text;
    document.body.append(area);
    area.select();
    const ok = document.execCommand && document.execCommand("copy");
    area.remove();
    return !!ok;
  }
}

/* --------------------------------------------------------------- menus */

// One open menu at a time; any click outside it, or Escape, closes it.
let openMenu = null;

export function toggleMenu(menu, button) {
  if (openMenu && openMenu.menu === menu) return closeMenu();
  closeMenu();
  menu.hidden = false;
  if (button) button.setAttribute("aria-expanded", "true");
  openMenu = { menu, button };
}

export function closeMenu() {
  if (!openMenu) return;
  openMenu.menu.hidden = true;
  if (openMenu.button) openMenu.button.setAttribute("aria-expanded", "false");
  openMenu = null;
}

document.addEventListener("click", (event) => {
  if (!openMenu) return;
  if (openMenu.menu.contains(event.target)) {
    if (event.target.closest("a, button")) closeMenu();
    return;
  }
  if (openMenu.button && openMenu.button.contains(event.target)) return;
  closeMenu();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && openMenu) {
    const button = openMenu.button;
    closeMenu();
    if (button) button.focus();
  }
});
