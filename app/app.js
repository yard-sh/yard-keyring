// Keyring app shell: boot, the hash router, the portal switch, the account
// menu, invite links, and the one live connection. Each screen is a view in
// landlord.js, tenant.js, tickets.js, notices.js or pay.js.
//
// Routes live in location.hash (relative URLs only; the app is served under
// /<slug>/app/):
//   #/l                                  landlord: your properties
//   #/l/p/<property>                     rent roll
//   #/l/p/<property>/u/<unit>            one unit: lease, people, ledger, history
//   #/l/p/<property>/requests[/<id>]     maintenance requests
//   #/l/p/<property>/notices             announcements
//   #/l/p/<property>/settings            details, contact card, delete
//   #/t/<lease>                          tenant: home
//   #/t/<lease>/payments                 the bill and its history
//   #/t/<lease>/requests[/new|/<id>]     maintenance requests
//   #/t/<lease>/notices                  announcements
//   #/r/<lease>/<code>                   one receipt, printable
//   #/welcome                            signed in, with no property or lease yet
//   anything else                        the portal used last, or the one you have
//
// A view is `async (ctx, ...params) => ({ propertyId, refresh, onEvent })`.
// It draws into ctx.root and says which property it shows, and the shell
// keeps one socket open to that property. Socket events are hints: the shell
// asks the view to re-fetch, unless the view handles the event itself.

import { api } from "./api.js";
import {
  $,
  h,
  icon,
  toast,
  store,
  modal,
  field,
  input,
  toggleMenu,
  closeMenu,
  money,
  keyTag,
  fmtDate,
  STATUS_LABEL,
} from "./ui.js";
import { createLive } from "./live.js";
import * as landlord from "./landlord.js";
import * as tenant from "./tenant.js";
import * as tickets from "./tickets.js";
import * as notices from "./notices.js";
import { receiptView } from "./pay.js";

const ID = "([0-9a-fA-F-]{36})";

const ROUTES = [
  [/^\/welcome$/, welcome],
  [/^\/gone\/(deleted|removed)$/, gone],
  [/^\/l$/, landlord.portfolio],
  [new RegExp(`^/l/p/${ID}$`), landlord.rentRoll],
  [new RegExp(`^/l/p/${ID}/u/${ID}$`), landlord.unit],
  [new RegExp(`^/l/p/${ID}/requests$`), (c, id) => tickets.list(c, "l", id)],
  [new RegExp(`^/l/p/${ID}/requests/${ID}$`), (c, id, tid) => tickets.detail(c, "l", id, tid)],
  [new RegExp(`^/l/p/${ID}/notices$`), (c, id) => notices.view(c, "l", id)],
  [new RegExp(`^/l/p/${ID}/settings$`), landlord.settings],
  [new RegExp(`^/t/${ID}$`), tenant.home],
  [new RegExp(`^/t/${ID}/payments$`), tenant.payments],
  [new RegExp(`^/t/${ID}/requests$`), (c, id) => tickets.list(c, "t", id)],
  [new RegExp(`^/t/${ID}/requests/new$`), (c, id) => tickets.create(c, id)],
  [new RegExp(`^/t/${ID}/requests/${ID}$`), (c, id, tid) => tickets.detail(c, "t", id, tid)],
  [new RegExp(`^/t/${ID}/notices$`), (c, id) => notices.view(c, "t", id)],
  [new RegExp(`^/r/${ID}/(KR-[A-Z2-9]{8})$`), receiptView],
];

const state = {
  me: null,
  view: null, // what the current view returned
  portal: null, // "l" | "t" | null
  seq: 0,
  refreshTimer: 0,
  meAt: 0,
};

const live = createLive({ onEvent, onStatus, onStop });

// What every view gets. root and stale() are per route.
const shell = {
  get me() {
    return state.me;
  },
  live,
  go,
  report,
  guard,
  refreshMe,
  title(text) {
    document.title = text ? text + " · Keyring" : "Keyring";
  },
};

/* ----------------------------------------------------------------- boot */

async function boot() {
  wireStatic();
  paintTheme();
  try {
    state.me = await api("api/me");
    state.meAt = Date.now();
  } catch (err) {
    report(err);
    return;
  }
  renderAccount();
  const invite = takeInvite();
  window.addEventListener("hashchange", route);
  await route();
  if (invite) await showInvite(invite);
}

function report(err) {
  if (err && err.status === 401) {
    toast(err.message, "error");
    setTimeout(() => location.reload(), 900);
    return;
  }
  toast((err && err.message) || "Something went wrong.", "error");
  if (err && !err.status) console.error(err);
}

// Wraps an event handler so a failure becomes a toast, not a silent reject.
function guard(fn) {
  return async (...args) => {
    try {
      await fn(...args);
    } catch (err) {
      report(err);
    }
  };
}

async function refreshMe() {
  const before = state.me;
  state.me = await api("api/me");
  state.meAt = Date.now();
  renderAccount();
  renderChrome();
  return before;
}

/* ---------------------------------------------------------------- route */

function go(hash) {
  if (location.hash === hash) route();
  else location.hash = hash;
}

// Signed in with nothing chosen yet: the portal the landing page's login
// button asked for (it stores the intent, because the hash may not survive
// a first sign-in's consent screen), else the one this person has.
function homeHash() {
  const me = state.me;
  const intent = store.get("keyring.portal");
  const lease = me.leases[0];
  const landlordish = me.landlord_plan || me.properties.length > 0;
  if (intent === "t" && lease) return "#/t/" + lease.id;
  if (intent === "l" && landlordish) return "#/l";
  if (landlordish) return "#/l";
  if (lease) return "#/t/" + lease.id;
  if (intent === "l") return "#/l";
  return "#/welcome";
}

async function route() {
  const seq = ++state.seq;
  closeMenu();
  // A link inside a dialog (View receipt) navigates; the dialog goes with it.
  for (const dialog of document.querySelectorAll("dialog[open]")) dialog.close();
  const path = location.hash.replace(/^#/, "") || "/";
  if (path === "/" || path === "") return location.replace(homeHash());
  if (path === "/t") {
    const lease = state.me.leases[0];
    return location.replace(lease ? "#/t/" + lease.id : "#/welcome");
  }

  let handler = null;
  let params = [];
  for (const [pattern, fn] of ROUTES) {
    const m = pattern.exec(path);
    if (m) {
      handler = fn;
      params = m.slice(1);
      break;
    }
  }
  if (!handler) return location.replace(homeHash());

  state.portal = path.startsWith("/l") ? "l" : path.startsWith("/t") ? "t" : state.portal;
  if (path.startsWith("/l") || path.startsWith("/t")) store.set("keyring.portal", state.portal);
  renderChrome();

  const root = $("view");
  const ctx = { ...shell, root, stale: () => seq !== state.seq, portal: state.portal };
  state.view = null;
  root.replaceChildren(h("div.loading", { "aria-label": "Loading" }, h("span"), h("span"), h("span")));
  window.scrollTo(0, 0);
  try {
    const view = await handler(ctx, ...params);
    if (seq !== state.seq) return;
    state.view = view || {};
    live.follow(state.view.propertyId || null);
  } catch (err) {
    if (seq !== state.seq) return;
    live.follow(null);
    if (err && err.status === 404) return lost();
    report(err);
    root.replaceChildren(
      h(
        "section.empty",
        {},
        h("h1.empty__title", {}, "That didn't load."),
        h("p", {}, err.message || "Try again."),
        h("a.btn.btn--ghost", { href: "#/" }, "Go home"),
      ),
    );
  }
}

// A property or lease that answers 404 isn't yours (any more): refresh what
// you have and go home.
async function lost() {
  toast("That isn't one of yours any more.", "error");
  await refreshMe().catch(() => {});
  location.replace(homeHash());
}

/* --------------------------------------------------------------- chrome */

function renderChrome() {
  const me = state.me;
  if (!me) return;
  const both = (me.landlord_plan || me.properties.length > 0) && me.leases.length > 0;
  $("portals").hidden = !both;
  $("portal-l").toggleAttribute("aria-current", state.portal === "l");
  $("portal-t").toggleAttribute("aria-current", state.portal === "t");
  const lease = me.leases[0];
  $("portal-t").href = lease ? "#/t/" + lease.id : "#/t";

  // A landlord whose trial or subscription ended keeps everything, read-only.
  const banner = $("banner");
  const lapsed = state.portal === "l" && !me.landlord_plan && me.properties.length > 0;
  banner.hidden = !lapsed;
  if (lapsed) {
    banner.replaceChildren(
      icon("alert"),
      h("span", {}, "Your Landlord plan isn't active, so your properties are read-only. Your tenants aren't affected."),
      h("a.banner__link", { href: "../#pricing" }, "Renew"),
    );
  }
}

function renderAccount() {
  const me = state.me;
  $("acct-avatar").textContent = (me.name || "?").charAt(0).toUpperCase();
  $("acct-name").textContent = me.name;
  $("acct-email").textContent = me.email || "";
  $("acct-plan").textContent =
    me.entitlement === "owner"
      ? "Project owner · Landlord tools included"
      : me.landlord_plan
        ? me.trial
          ? "Landlord plan · free trial"
          : "Landlord plan"
        : "Tenant · free";
}

function wireStatic() {
  $("theme").addEventListener("click", () => {
    const next = currentTheme() === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    store.set("keyring.theme", next);
    paintTheme();
  });
  $("acct-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    toggleMenu($("acct-menu"), $("acct-btn"));
  });
  $("acct-rename").addEventListener("click", guard(rename));

  // Entitlement is cached by the edge for up to a minute and nothing is
  // pushed, so a purchase or a lapsed trial shows up when the window comes
  // back into focus.
  window.addEventListener("focus", () => {
    if (!state.me || Date.now() - state.meAt < 15000) return;
    const plan = state.me.landlord_plan;
    refreshMe()
      .then(() => {
        if (state.me.landlord_plan !== plan) route();
      })
      .catch(() => {});
  });
}

function currentTheme() {
  return (
    document.documentElement.dataset.theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
  );
}

function paintTheme() {
  $("theme").setAttribute("aria-label", currentTheme() === "dark" ? "Switch to light" : "Switch to dark");
}

async function rename() {
  const name = await modal({
    title: "Your display name",
    content: field(
      "Shown to your landlord, tenants and roommates",
      input("name", { value: state.me.name, maxlength: 40, required: true }),
    ),
    onSubmit: async (form) => {
      const value = form.elements.name.value.trim();
      if (!value) throw new Error("Pick a name.");
      return (await api("api/me", { method: "PATCH", body: { name: value } })).name;
    },
  });
  if (!name) return;
  state.me.name = name;
  renderAccount();
  toast("Name updated.");
  if (state.view && state.view.refresh) state.view.refresh();
}

/* ----------------------------------------------------------------- live */

function onStatus(value) {
  $("livedot").hidden = value !== "open";
}

function onEvent(event) {
  const view = state.view;
  if (!view) return;
  if (event.t === "hello") return scheduleRefresh();
  toastFor(event);
  if (event.t === "property.changed") refreshMe().catch(() => {});
  if (view.onEvent && view.onEvent(event) === true) return;
  if (event.t !== "typing" && event.t !== "comment" && event.t !== "error") scheduleRefresh();
}

// Several events in a burst re-fetch once.
function scheduleRefresh() {
  clearTimeout(state.refreshTimer);
  state.refreshTimer = setTimeout(() => {
    if (state.view && state.view.refresh) state.view.refresh();
  }, 150);
}

// Tell people about what someone else just did.
function toastFor(e) {
  const me = state.me.user_id;
  const landlordSide = state.portal === "l";
  if (e.t === "announcement.posted" && !landlordSide) toast("New announcement: " + e.title);
  if (e.t === "ticket.updated" && e.created && landlordSide) toast("New request from unit " + e.unit);
  if (e.t === "ticket.updated" && !e.created && !landlordSide && e.title) {
    toast(`“${e.title}” is now ${(STATUS_LABEL[e.status] || e.status).toLowerCase()}`);
  }
  if (e.t === "ledger.changed" && e.kind === "paid" && e.by_id !== me) {
    toast(landlordSide ? `Unit ${e.unit}: ${e.by} paid ${money(e.cents)}` : `${e.by} paid ${money(e.cents)}`);
  }
  if (e.t === "ledger.changed" && e.kind === "charge" && !landlordSide)
    toast("New charge on your bill: " + money(e.cents));
}

async function onStop(why, propertyId) {
  const view = state.view;
  await refreshMe().catch(() => {});
  if (view && view.propertyId === propertyId) location.replace("#/gone/" + why);
}

/* -------------------------------------------------------------- invites */

function takeInvite() {
  const params = new URLSearchParams(location.search);
  const token = params.get("invite");
  if (!token) return null;
  params.delete("invite");
  const query = params.toString();
  history.replaceState(null, "", location.pathname + (query ? "?" + query : "") + location.hash);
  return token;
}

async function showInvite(token) {
  let invite;
  try {
    invite = await api("api/invites/" + encodeURIComponent(token));
  } catch (err) {
    return toast(err.message.charAt(0).toUpperCase() + err.message.slice(1) + ".", "error");
  }
  if (invite.already_tenant) {
    go("#/t/" + invite.lease_id);
    return toast(`You already live in unit ${invite.unit_number}.`);
  }
  if (invite.is_landlord) return toast("That's an invite into your own property. Send it to your tenant.", "error");

  const content = h(
    "div.invite",
    {},
    h("div.invite__tag", {}, keyTag(invite.unit_number, "xl")),
    h("p.invite__where", {}, invite.property.name),
    invite.property.address ? h("p.invite__addr", {}, invite.property.address) : null,
    h(
      "dl.facts",
      {},
      h("div", {}, h("dt", {}, "Landlord"), h("dd", {}, invite.landlord_name)),
      h("div", {}, h("dt", {}, "Rent"), h("dd.mono", {}, money(invite.rent_cents) + " / month")),
      h("div", {}, h("dt", {}, "Due"), h("dd", {}, "on day " + invite.due_day)),
      h("div", {}, h("dt", {}, "Lease starts"), h("dd", {}, fmtDate(invite.starts_at))),
    ),
    invite.sent_to_you === false
      ? h(
          "p.note.note--warn",
          {},
          "This link was sent to a different email address than the one you're signed in with. Only join if it's meant for you: a link works once.",
        )
      : null,
  );
  const joined = await modal({
    title: "Join unit " + invite.unit_number,
    content,
    confirm: "Join this unit",
    onSubmit: () => api(`api/invites/${encodeURIComponent(token)}/claim`, { method: "POST" }),
  });
  if (!joined) return;
  await refreshMe();
  go("#/t/" + joined.lease_id);
  live.reconnect();
  toast(`Welcome home to unit ${invite.unit_number}.`);
}

/* ------------------------------------------------------- simple screens */

// Signed in, but no property and no lease yet.
async function welcome(ctx) {
  ctx.title("Welcome");
  ctx.root.replaceChildren(
    h(
      "section.welcome",
      {},
      h("p.eyebrow", {}, "Welcome to Keyring"),
      h("h1.display", {}, "Which door is yours?"),
      h(
        "div.welcome__grid",
        {},
        h(
          "article.choice",
          {},
          icon("door", "icon icon--xl"),
          h("h2", {}, "I rent a place"),
          h(
            "p",
            {},
            "Your landlord sends you an invite link. Open it while signed in here and your unit appears, with your bill, requests and announcements.",
          ),
          h("p.choice__muted", {}, "No link yet? Ask your landlord to invite you from their Keyring."),
        ),
        h(
          "article.choice",
          {},
          icon("building", "icon icon--xl"),
          h("h2", {}, "I'm a landlord"),
          h(
            "p",
            {},
            "Run your buildings from one ring: rent roll, invites, requests and announcements. $50 a month, and your tenants never pay.",
          ),
          h("a.btn.btn--primary", { href: "../#pricing" }, "Start a 14-day free trial"),
        ),
      ),
    ),
  );
  return {};
}

// After a live socket closed with 4002 or 4003.
async function gone(ctx, why) {
  ctx.title(why === "deleted" ? "Property deleted" : "No access");
  ctx.root.replaceChildren(
    h(
      "section.empty.empty--gone",
      { "data-gone": why },
      icon(why === "deleted" ? "building" : "key", "icon icon--xl"),
      h(
        "h1.empty__title",
        {},
        why === "deleted" ? "This property was deleted." : "You no longer have access to this property.",
      ),
      h(
        "p",
        {},
        why === "deleted"
          ? "Its landlord removed it from Keyring, along with its leases and requests."
          : "Your landlord ended your lease or removed you from it. If that's a mistake, ask them for a new invite link.",
      ),
      h("a.btn.btn--ghost", { href: "#/" }, "Go home"),
    ),
  );
  return {};
}

boot();
