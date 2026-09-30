// The landlord portal: properties, the rent roll, one unit (its lease, its
// people and its ledger), and a property's settings. Requests and
// announcements are shared with the tenant portal (tickets.js, notices.js)
// and borrow this file's frame.
//
// Every write button is shown only when the server says can_write, and the
// server refuses the write anyway without the Landlord plan: the app only
// explains refusals, it never enforces anything.

import { api, ApiError } from "./api.js";
import {
  h,
  icon,
  keyTag,
  money,
  parseMoney,
  centsToInput,
  fmtDate,
  fmtDay,
  fmtMonth,
  todayISO,
  nextMonthKey,
  plural,
  pill,
  avatar,
  toast,
  modal,
  confirmModal,
  field,
  input,
  textarea,
  select,
  copyText,
  signature,
} from "./ui.js";

const TABS = [
  ["", "Rent roll", "building"],
  ["/requests", "Requests", "wrench"],
  ["/notices", "Announcements", "megaphone"],
  ["/settings", "Settings", "gear"],
];

/* ---------------------------------------------------------------- frame */

// The header every property page shares: name, address, tabs. Tenants who
// wander onto a landlord URL get the same 404 as a stranger.
export async function propertyFrame(ctx, propertyId, tab) {
  const property = await api("api/properties/" + propertyId);
  if (property.role !== "landlord") throw new ApiError("not found", 404, "not_found");
  const body = h("div.frame__body");
  const base = "#/l/p/" + propertyId;
  ctx.root.replaceChildren(
    h(
      "section.frame",
      {},
      h(
        "header.frame__head",
        {},
        h("a.crumb", { href: "#/l" }, icon("back"), "All properties"),
        h("h1.frame__name", {}, property.name),
        property.address ? h("p.frame__sub", {}, property.address) : null,
      ),
      h(
        "nav.tabs",
        { "aria-label": "Property" },
        TABS.map(([path, label, name]) =>
          h(
            "a.tabs__tab",
            { href: base + path, "aria-current": path === tab ? "page" : null },
            icon(name),
            h("span", {}, label),
          ),
        ),
      ),
      body,
    ),
  );
  return { body, property };
}

/* ------------------------------------------------------------ portfolio */

export async function portfolio(ctx) {
  ctx.title("Your properties");
  const me = ctx.me;
  const body = h("div.page");
  ctx.root.replaceChildren(body);

  async function refresh() {
    const properties = await api("api/properties");
    if (ctx.stale()) return;
    paint(properties);
  }

  function paint(properties) {
    const head = h(
      "header.page__head",
      {},
      h("div", {}, h("p.eyebrow", {}, "Landlord"), h("h1.page__title", {}, "Your properties")),
      me.landlord_plan
        ? h("button.btn.btn--brass", { type: "button", onclick: ctx.guard(newProperty) }, icon("plus"), "New property")
        : null,
    );

    if (!properties.length && !me.landlord_plan) {
      body.replaceChildren(head, planPitch());
      return;
    }
    if (!properties.length) {
      body.replaceChildren(
        head,
        h(
          "section.empty",
          {},
          h("div.empty__ring", {}, keyTag("1A", "lg")),
          h("h2.empty__title", {}, "Add your first property"),
          h(
            "p",
            {},
            "A building, a duplex, a single house: give it a name, add its units, and invite the people who live there.",
          ),
          h("button.btn.btn--brass", { type: "button", onclick: ctx.guard(newProperty) }, icon("plus"), "New property"),
        ),
      );
      return;
    }
    body.replaceChildren(
      head,
      h(
        "div.cards",
        {},
        properties.map((p) => {
          const pct = p.units ? Math.round((p.occupied / p.units) * 100) : 0;
          return h(
            "a.propcard",
            { href: "#/l/p/" + p.id },
            h("span.propcard__icon", {}, icon("building")),
            h("h2.propcard__name", {}, p.name),
            h("p.propcard__addr", {}, p.address || "No address yet"),
            h(
              "div.meter",
              { role: "img", "aria-label": `${pct}% occupied` },
              h("span.meter__fill", { style: { width: pct + "%" } }),
            ),
            h(
              "p.propcard__stats",
              {},
              h("span", {}, plural(p.units, "unit") + " · " + p.occupied + " leased"),
              p.open_tickets
                ? h("span.propcard__flag", {}, icon("wrench"), plural(p.open_tickets, "open request"))
                : null,
            ),
          );
        }),
      ),
    );
  }

  async function newProperty() {
    const made = await modal({
      title: "New property",
      content: h(
        "div.stack",
        {},
        field("Name", input("name", { placeholder: "Maple Court", maxlength: 80, required: true })),
        field("Address", input("address", { placeholder: "12 Maple Avenue, Springfield", maxlength: 160 })),
        h(
          "div.row2",
          {},
          field("Office phone", input("phone", { maxlength: 30, inputmode: "tel" })),
          field("Emergency line", input("emergency", { maxlength: 30, inputmode: "tel" })),
        ),
        field(
          "Office hours",
          input("hours", { placeholder: "Mon–Fri, 9–5", maxlength: 80 }),
          "Tenants see these on their home page.",
        ),
      ),
      confirm: "Create property",
      onSubmit: (form) => {
        const v = (k) => form.elements[k].value;
        if (!v("name").trim()) throw new Error("Give the property a name.");
        return api("api/properties", {
          method: "POST",
          body: {
            name: v("name"),
            address: v("address"),
            phone: v("phone"),
            emergency: v("emergency"),
            hours: v("hours"),
          },
        });
      },
    });
    if (!made) return;
    await ctx.refreshMe();
    ctx.go("#/l/p/" + made.id);
  }

  await refresh();
  return { refresh };
}

function planPitch() {
  return h(
    "section.pitch",
    {},
    h("div.pitch__tag", {}, keyTag("PH", "xl")),
    h(
      "div",
      {},
      h("h2.pitch__title", {}, "Managing properties is part of the Landlord plan."),
      h(
        "p",
        {},
        "$50 a month for up to 25 properties with 300 units each. Try it free for 14 days, no card needed. Your tenants never pay.",
      ),
      h("a.btn.btn--brass", { href: "../#pricing" }, "See the Landlord plan"),
    ),
  );
}

/* ------------------------------------------------------------- rent roll */

export async function rentRoll(ctx, propertyId) {
  const { body, property } = await propertyFrame(ctx, propertyId, "");
  ctx.title(property.name);

  async function refresh() {
    const roll = await api(`api/properties/${propertyId}/rentroll`);
    if (ctx.stale()) return;
    paint(roll);
  }

  function paint(roll) {
    const s = roll.stats;
    const month = new Date(roll.as_of).toLocaleString("en-US", { month: "long", timeZone: "UTC" });
    const occupancy = s.units ? Math.round((s.occupied / s.units) * 100) : 0;
    const stats = h(
      "section.stats",
      { "aria-label": "This month" },
      stat(
        "Occupied",
        `${s.occupied}/${s.units}`,
        h("div.meter", {}, h("span.meter__fill", { style: { width: occupancy + "%" } })),
        "occupied",
      ),
      stat(`Collected in ${month}`, money(s.collected_month_cents), null, "collected"),
      stat(
        "Outstanding",
        money(s.outstanding_cents),
        s.overdue_leases
          ? h("span.stat__flag", {}, icon("alert"), plural(s.overdue_leases, "lease") + " overdue")
          : h("span.stat__ok", {}, "Nothing overdue"),
        "outstanding",
      ),
      h(
        "a.stat.stat--link",
        { href: `#/l/p/${propertyId}/requests`, "data-stat": "requests" },
        h("span.stat__label", {}, "Open requests"),
        h("span.stat__value", {}, String(s.open_tickets)),
        h("span.stat__more", {}, "View requests", icon("next")),
      ),
    );

    const head = h(
      "div.section__head",
      {},
      h("h2.section__title", {}, "Units"),
      roll.can_write
        ? h("button.btn.btn--ghost", { type: "button", onclick: ctx.guard(addUnits) }, icon("plus"), "Add units")
        : null,
    );

    if (!roll.units.length) {
      body.replaceChildren(
        stats,
        head,
        h(
          "div.empty.empty--inline",
          {},
          h("p", {}, "No units yet. Add them all at once: ranges like 101-110 or 2A-2F work."),
          roll.can_write
            ? h("button.btn.btn--brass", { type: "button", onclick: ctx.guard(addUnits) }, icon("plus"), "Add units")
            : null,
        ),
      );
      return;
    }

    const table = h(
      "div.roll",
      { role: "table", "aria-label": "Rent roll" },
      h(
        "div.roll__row.roll__row--head",
        { role: "row" },
        ["Unit", "Tenants", "Rent", "Status", "Balance"].map((t) => h("span", { role: "columnheader" }, t)),
      ),
      roll.units.map((u) => unitRow(propertyId, u)),
    );
    body.replaceChildren(stats, head, table);
  }

  async function addUnits() {
    const res = await modal({
      title: "Add units",
      content: h(
        "div.stack",
        {},
        field(
          "Unit numbers",
          textarea("numbers", { rows: 3, placeholder: "101-110, 2A-2F, PH" }),
          "Separate with commas or new lines. Ranges count up: 101-110, or 2A-2F.",
        ),
      ),
      confirm: "Add units",
      onSubmit: (form) => {
        const numbers = expandUnits(form.elements.numbers.value);
        if (!numbers.length) throw new Error("List at least one unit number.");
        if (numbers.length > 100) throw new Error(`That's ${numbers.length} units; add up to 100 at a time.`);
        return api(`api/properties/${propertyId}/units`, { method: "POST", body: { numbers } });
      },
    });
    if (!res) return;
    toast(
      res.skipped
        ? `Added ${plural(res.created, "unit")}; ${res.skipped} already existed.`
        : `Added ${plural(res.created, "unit")}.`,
    );
    await refresh();
  }

  await refresh();
  return { propertyId, refresh };
}

function stat(label, value, extra, key) {
  return h("div.stat", { "data-stat": key }, h("span.stat__label", {}, label), h("span.stat__value", {}, value), extra);
}

function unitRow(propertyId, u) {
  const href = `#/l/p/${propertyId}/u/${u.unit_id}`;
  if (!u.lease) {
    return h(
      "a.roll__row.roll__row--vacant",
      { href, role: "row", "data-unit": u.number },
      h("span", { role: "cell" }, keyTag(u.number)),
      h("span.roll__muted", { role: "cell" }, "Vacant"),
      h("span", { role: "cell" }),
      h("span", { role: "cell" }, pill("vacant", "Vacant")),
      h("span.roll__go", { role: "cell" }, "Start a lease", icon("next")),
    );
  }
  const l = u.lease;
  const status =
    l.balance_cents === 0
      ? pill("paid", "Paid up")
      : l.overdue_cents > 0
        ? pill("overdue", "Overdue")
        : pill("open", "Due " + fmtDay(l.next_due));
  const people = l.tenants.length
    ? l.tenants.join(", ")
    : l.pending_invites
      ? plural(l.pending_invites, "invite") + " sent"
      : "No tenants yet";
  return h(
    "a.roll__row",
    { href, role: "row", "data-unit": u.number },
    h("span", { role: "cell" }, keyTag(u.number)),
    h(
      "span.roll__people",
      { role: "cell", "data-label": "Tenants" },
      people,
      l.term_over ? h("span.chip.chip--warn", {}, "Term over") : null,
    ),
    h("span.mono", { role: "cell", "data-label": "Rent" }, money(l.rent_cents)),
    h("span", { role: "cell", "data-label": "Status" }, status),
    h("span.mono.roll__balance", { role: "cell", "data-label": "Balance" }, money(l.balance_cents)),
  );
}

// "101-104, 2A-2C, PH" → 101 102 103 104 2A 2B 2C PH.
export function expandUnits(text) {
  const out = [];
  for (const raw of String(text || "").split(/[,\n]/)) {
    const part = raw.trim();
    if (!part) continue;
    const num = /^(\d+)\s*[-–]\s*(\d+)$/.exec(part);
    const letter = /^(.*?)([A-Za-z])\s*[-–]\s*\1([A-Za-z])$/.exec(part);
    if (num && Number(num[2]) >= Number(num[1]) && Number(num[2]) - Number(num[1]) < 300) {
      const width = num[1].length;
      for (let n = Number(num[1]); n <= Number(num[2]); n++) out.push(String(n).padStart(width, "0"));
    } else if (letter && letter[3].charCodeAt(0) >= letter[2].charCodeAt(0)) {
      for (let c = letter[2].charCodeAt(0); c <= letter[3].charCodeAt(0); c++)
        out.push(letter[1] + String.fromCharCode(c));
    } else {
      out.push(part);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ unit */

export async function unit(ctx, propertyId, unitId) {
  const { body, property } = await propertyFrame(ctx, propertyId, "");
  let unitData = null;
  let lease = null;
  let drawn = "";

  // Repaints only when something changed, so a live event or a reconnect
  // never wipes a half-filled "Start a lease" form.
  async function refresh() {
    const next = await api("api/units/" + unitId);
    const nextLease = next.running_lease_id ? await api("api/leases/" + next.running_lease_id) : null;
    if (ctx.stale()) return;
    const sig = signature([next, nextLease]);
    if (sig === drawn) return;
    drawn = sig;
    unitData = next;
    lease = nextLease;
    ctx.title(`Unit ${unitData.unit.number} · ${property.name}`);
    paint();
  }

  // Other units' news is none of this page's business.
  function onEvent(e) {
    if (e.lease_id && (!lease || e.lease_id !== lease.lease.id)) return true;
    return false;
  }

  function paint() {
    const u = unitData.unit;
    const canWrite = unitData.can_write;
    const head = h(
      "header.unit__head",
      {},
      h("a.crumb", { href: "#/l/p/" + propertyId }, icon("back"), "Rent roll"),
      h(
        "div.unit__title",
        {},
        keyTag(u.number, "xl"),
        h(
          "div",
          {},
          h("h2.unit__name", {}, "Unit " + u.number),
          h(
            "p.unit__sub",
            {},
            lease
              ? lease.tenants.length
                ? lease.tenants.map((t) => t.name).join(", ")
                : "Waiting for tenants to join"
              : "Vacant",
          ),
        ),
        canWrite
          ? h(
              "button.btn.btn--ghost.btn--sm",
              { type: "button", onclick: ctx.guard(renameUnit) },
              icon("pencil"),
              "Rename",
            )
          : null,
      ),
    );

    const parts = [head];
    if (lease) parts.push(leaseSections(canWrite));
    else parts.push(canWrite ? startLeaseCard() : h("p.note", {}, "This unit is vacant."));

    const past = unitData.leases.filter((l) => l.ended_at !== null);
    if (past.length) {
      parts.push(
        h(
          "section.card",
          {},
          h("h3.card__title", {}, "Past leases"),
          h(
            "ul.history",
            {},
            past.map((l) =>
              h(
                "li",
                {},
                h("span.mono", {}, fmtDate(l.starts_at) + " – " + fmtDate(l.ends_at || l.ended_at)),
                h("span", {}, l.tenants.length ? l.tenants.join(", ") : "No tenants"),
                h("span.mono", {}, money(l.rent_cents) + "/mo"),
              ),
            ),
          ),
        ),
      );
    }
    if (!lease && canWrite) {
      parts.push(
        h(
          "section.danger",
          {},
          h(
            "div",
            {},
            h("h3", {}, "Delete this unit"),
            h(
              "p",
              {},
              past.length
                ? `Its ${plural(past.length, "past lease")} and their ledgers go with it.`
                : "It has no history.",
            ),
          ),
          h("button.btn.btn--danger", { type: "button", onclick: ctx.guard(deleteUnit) }, icon("trash"), "Delete unit"),
        ),
      );
    }
    body.replaceChildren(...parts);
  }

  /* vacant */

  function startLeaseCard() {
    const form = h(
      "form.card.lease-form",
      { novalidate: true },
      h("h3.card__title", {}, "Start a lease"),
      h(
        "p.card__sub",
        {},
        "Set the terms, then invite the people who'll live here. Each invite is a link that works once.",
      ),
      h(
        "div.row3",
        {},
        field(
          "Monthly rent",
          h(
            "span.money-input",
            {},
            h("span", {}, "$"),
            input("rent", { inputmode: "decimal", placeholder: "1,850.00", required: true }),
          ),
        ),
        field(
          "Rent due on day",
          select(
            "due_day",
            Array.from({ length: 28 }, (_, i) => [String(i + 1), String(i + 1)]),
            "1",
          ),
        ),
        field("Lease starts", input("starts_on", { type: "date", value: todayISO(), required: true })),
      ),
      h(
        "div.row2",
        {},
        field("Lease ends (optional)", input("ends_on", { type: "date" }), "Leave empty for month to month."),
        field(
          "Tenant emails",
          input("emails", { placeholder: "sam@example.com, alex@example.com" }),
          "Up to 6. We make one invite link for each.",
        ),
      ),
      h("p.form__error", { role: "alert", hidden: true }),
      h(
        "div.form__actions",
        {},
        h("button.btn.btn--brass", { type: "submit" }, icon("key"), "Start lease and make invites"),
      ),
    );
    form.addEventListener(
      "submit",
      ctx.guard(async (e) => {
        e.preventDefault();
        const error = form.querySelector(".form__error");
        error.hidden = true;
        const v = (k) => form.elements[k].value;
        const rent = parseMoney(v("rent"));
        try {
          if (rent === null) throw new Error("Enter the monthly rent, like 1850 or 1,850.00.");
          const emails = v("emails")
            .split(/[,\s;]+/)
            .filter(Boolean);
          const made = await api(`api/units/${unitId}/leases`, {
            method: "POST",
            body: {
              rent_cents: rent,
              due_day: Number(v("due_day")),
              starts_on: v("starts_on"),
              ends_on: v("ends_on") || null,
              emails,
            },
          });
          await refresh();
          if (made.invites.length) await showLinks(made.invites);
        } catch (err) {
          error.textContent = err.message.charAt(0).toUpperCase() + err.message.slice(1);
          error.hidden = false;
        }
      }),
    );
    return form;
  }

  /* running */

  function leaseSections(canWrite) {
    return h(
      "div.unit__grid",
      {},
      ledgerCard(canWrite),
      h("div.unit__side", {}, termsCard(canWrite), peopleCard(canWrite)),
    );
  }

  function termsCard(canWrite) {
    const steps = lease.lease.rent_steps;
    const upcoming = steps.filter((s) => s.month > new Date(lease.as_of).toISOString().slice(0, 7));
    return h(
      "section.card",
      { "data-card": "terms" },
      h("h3.card__title", {}, "Lease"),
      h(
        "dl.facts",
        {},
        h("div", {}, h("dt", {}, "Rent"), h("dd.mono", {}, money(lease.rent_cents) + " / month")),
        h("div", {}, h("dt", {}, "Due"), h("dd", {}, "Day " + lease.lease.due_day + " of each month")),
        h("div", {}, h("dt", {}, "Started"), h("dd", {}, fmtDate(lease.lease.starts_at))),
        h(
          "div",
          {},
          h("dt", {}, "Ends"),
          h("dd", {}, lease.lease.ends_at ? fmtDate(lease.lease.ends_at) : "Month to month"),
        ),
        upcoming.map((s) =>
          h("div", {}, h("dt", {}, "From " + fmtMonth(s.month)), h("dd.mono", {}, money(s.rent_cents) + " / month")),
        ),
      ),
      canWrite
        ? h(
            "div.card__actions",
            {},
            h("button.btn.btn--ghost.btn--sm", { type: "button", onclick: ctx.guard(changeRent) }, "Change rent"),
            h("button.btn.btn--ghost.btn--sm", { type: "button", onclick: ctx.guard(setEnd) }, "Set end date"),
            h("button.btn.btn--danger-ghost.btn--sm", { type: "button", onclick: ctx.guard(endLease) }, "End lease"),
          )
        : null,
    );
  }

  function peopleCard(canWrite) {
    const open = lease.invites.filter((i) => !i.expired);
    const seats = lease.tenants.length + open.length;
    return h(
      "section.card",
      { "data-card": "people" },
      h("h3.card__title", {}, "People"),
      lease.tenants.length
        ? h(
            "ul.people",
            {},
            lease.tenants.map((t) =>
              h(
                "li.person",
                { "data-person": t.user_id },
                avatar(t.name, t.user_id),
                h(
                  "div.person__who",
                  {},
                  h("span.person__name", {}, t.name),
                  h("span.person__meta", {}, (t.email || "") + " · joined " + fmtDay(t.joined_at)),
                ),
                canWrite
                  ? h(
                      "button.iconbtn",
                      {
                        type: "button",
                        "aria-label": "Remove " + t.name,
                        title: "Remove from lease",
                        onclick: ctx.guard(() => removeTenant(t)),
                      },
                      icon("x"),
                    )
                  : null,
              ),
            ),
          )
        : h("p.card__sub", {}, "Nobody has joined yet."),
      lease.invites.length
        ? h(
            "ul.invites",
            {},
            lease.invites.map((i) =>
              h(
                "li.invite-row" + (i.expired ? ".is-expired" : ""),
                { "data-invite": i.id },
                icon("mail"),
                h(
                  "div.person__who",
                  {},
                  h("span.person__name", {}, i.email || "Invite link"),
                  h("span.person__meta", {}, i.expired ? "Expired" : "Link works until " + fmtDay(i.expires_at)),
                ),
                i.expired
                  ? null
                  : h(
                      "span.invite-row__actions",
                      {},
                      h(
                        "button.iconbtn",
                        {
                          type: "button",
                          "aria-label": "Copy invite link",
                          title: "Copy link",
                          "data-copy": inviteLink(i.token),
                          onclick: ctx.guard(() => copyLink(i)),
                        },
                        icon("copy"),
                      ),
                      h(
                        "a.iconbtn",
                        { href: mailto(i), "aria-label": "Email the invite", title: "Email it" },
                        icon("send"),
                      ),
                    ),
                canWrite
                  ? h(
                      "button.iconbtn",
                      {
                        type: "button",
                        "aria-label": "Revoke invite",
                        title: "Revoke",
                        onclick: ctx.guard(() => revoke(i)),
                      },
                      icon("trash"),
                    )
                  : null,
              ),
            ),
          )
        : null,
      canWrite && seats < 6
        ? h(
            "div.card__actions",
            {},
            h(
              "button.btn.btn--ghost.btn--sm",
              { type: "button", onclick: ctx.guard(invite) },
              icon("plus"),
              "Invite a tenant",
            ),
          )
        : null,
    );
  }

  function ledgerCard(canWrite) {
    const items = [...lease.items].reverse();
    return h(
      "section.card.ledger",
      { "data-card": "ledger" },
      h(
        "div.ledger__head",
        {},
        h(
          "div",
          {},
          h("h3.card__title", {}, "Ledger"),
          h(
            "p.ledger__balance",
            {},
            h("span", {}, "Balance "),
            h("strong.mono", {}, money(lease.balance_cents)),
            lease.overdue_cents ? h("span.ledger__overdue", {}, money(lease.overdue_cents) + " overdue") : null,
          ),
        ),
        canWrite
          ? h(
              "div.card__actions",
              {},
              h(
                "button.btn.btn--ghost.btn--sm",
                { type: "button", onclick: ctx.guard(addCharge) },
                icon("plus"),
                "Add charge",
              ),
              lease.balance_cents
                ? h(
                    "button.btn.btn--ghost.btn--sm",
                    { type: "button", onclick: ctx.guard(recordPayment) },
                    icon("receipt"),
                    "Record payment",
                  )
                : null,
            )
          : null,
      ),
      items.length
        ? h(
            "ul.items",
            {},
            items.map((item) =>
              h(
                "li.item.item--" + item.status,
                { "data-ref": item.ref },
                h("span.item__date.mono", {}, fmtDay(item.due_at)),
                h("span.item__label", {}, item.label, item.paid ? h("span.item__meta", {}, paidLine(item)) : null),
                h("span.item__amount.mono", {}, money(item.amount_cents)),
                pill(item.status),
                item.paid
                  ? h(
                      "a.iconbtn",
                      {
                        href: `#/r/${lease.lease.id}/${item.paid.confirmation}`,
                        "aria-label": "Receipt",
                        title: "Receipt",
                      },
                      icon("receipt"),
                    )
                  : canWrite && item.charge_id
                    ? h(
                        "button.iconbtn",
                        {
                          type: "button",
                          "aria-label": "Void charge",
                          title: "Void",
                          onclick: ctx.guard(() => voidCharge(item)),
                        },
                        icon("trash"),
                      )
                    : h("span.iconbtn-spacer"),
              ),
            ),
          )
        : h(
            "p.card__sub",
            {},
            lease.next_rent
              ? `First rent (${money(lease.next_rent.amount_cents)}) is due ${fmtDate(lease.next_rent.due_at)}.`
              : "Nothing billed yet.",
          ),
    );
  }

  /* actions */

  async function renameUnit() {
    const res = await modal({
      title: "Rename unit",
      content: field("Unit number", input("number", { value: unitData.unit.number, maxlength: 20 })),
      onSubmit: (form) => api("api/units/" + unitId, { method: "PATCH", body: { number: form.elements.number.value } }),
    });
    if (res) await refresh();
  }

  async function deleteUnit() {
    const ok = await confirmModal({
      title: `Delete unit ${unitData.unit.number}?`,
      body: "The unit and every past lease on it, with their ledgers and requests, are deleted for good.",
      confirm: "Delete unit",
      danger: true,
    });
    if (!ok) return;
    await api("api/units/" + unitId, { method: "DELETE" });
    toast(`Unit ${unitData.unit.number} deleted.`);
    ctx.go("#/l/p/" + propertyId);
  }

  async function changeRent() {
    const months = [];
    const start = nextMonthKey();
    let [y, m] = start.split("-").map(Number);
    for (let i = 0; i < 12; i++) {
      months.push([`${y}-${String(m).padStart(2, "0")}`, fmtMonth(`${y}-${String(m).padStart(2, "0")}`)]);
      m += 1;
      if (m > 12) ((m = 1), (y += 1));
    }
    const res = await modal({
      title: "Change rent",
      content: h(
        "div.stack",
        {},
        field(
          "New monthly rent",
          h(
            "span.money-input",
            {},
            h("span", {}, "$"),
            input("rent", { inputmode: "decimal", value: centsToInput(lease.rent_cents) }),
          ),
        ),
        field(
          "Starting with",
          select("from", months, start),
          "Rent already billed never changes. A later change you had scheduled is replaced.",
        ),
      ),
      confirm: "Change rent",
      onSubmit: (form) => {
        const rent = parseMoney(form.elements.rent.value);
        if (rent === null) throw new Error("Enter the new rent, like 1900.");
        return api("api/leases/" + lease.lease.id, {
          method: "PATCH",
          body: { rent_cents: rent, from_month: form.elements.from.value },
        });
      },
    });
    if (res) {
      toast("Rent change scheduled.");
      await refresh();
    }
  }

  async function setEnd() {
    const current = lease.lease.ends_at ? new Date(lease.lease.ends_at).toISOString().slice(0, 10) : "";
    const res = await modal({
      title: "Lease end date",
      content: field(
        "Last day of the lease",
        input("ends_on", { type: "date", value: current }),
        "Rent stops after this date. Clear it for month to month.",
      ),
      onSubmit: (form) =>
        api("api/leases/" + lease.lease.id, {
          method: "PATCH",
          body: { ends_on: form.elements.ends_on.value || null },
        }),
    });
    if (res) await refresh();
  }

  async function endLease() {
    const res = await modal({
      title: `End the lease on unit ${unitData.unit.number}?`,
      content: h(
        "div.stack",
        {},
        h(
          "p.modal__text",
          {},
          "The tenants lose access to this unit right away, and it becomes vacant. Its ledger stays in your records.",
        ),
        field("Last day", input("last_day", { type: "date", value: todayISO(), max: todayISO() })),
      ),
      confirm: "End lease",
      danger: true,
      onSubmit: (form) =>
        api(`api/leases/${lease.lease.id}/end`, { method: "POST", body: { last_day: form.elements.last_day.value } }),
    });
    if (res) {
      toast("Lease ended.");
      await refresh();
    }
  }

  async function removeTenant(t) {
    const ok = await confirmModal({
      title: `Remove ${t.name}?`,
      body: `${t.name} loses access to unit ${unitData.unit.number} right away. The lease and its ledger stay as they are.`,
      confirm: "Remove",
      danger: true,
    });
    if (!ok) return;
    await api(`api/leases/${lease.lease.id}/tenants/${encodeURIComponent(t.user_id)}`, { method: "DELETE" });
    toast(`${t.name} was removed.`);
    await refresh();
  }

  async function invite() {
    const made = await modal({
      title: "Invite a tenant",
      content: field(
        "Their email",
        input("email", { type: "email", placeholder: "sam@example.com" }),
        "We make a link that works once, for 14 days. Send it however you like.",
      ),
      confirm: "Make invite link",
      onSubmit: (form) =>
        api(`api/leases/${lease.lease.id}/invites`, { method: "POST", body: { email: form.elements.email.value } }),
    });
    if (!made) return;
    await refresh();
    await showLinks([made]);
  }

  async function revoke(i) {
    await api(`api/leases/${lease.lease.id}/invites/${i.id}`, { method: "DELETE" });
    toast("Invite revoked. That link no longer works.");
    await refresh();
  }

  async function copyLink(i) {
    toast((await copyText(inviteLink(i.token))) ? "Invite link copied." : "Couldn't copy; select the link instead.");
  }

  function mailto(i) {
    const subject = `Your Keyring invite: unit ${unitData.unit.number} at ${property.name}`;
    const text =
      `You're invited to unit ${unitData.unit.number} at ${property.name} on Keyring, where you'll see your rent, ` +
      `requests and building announcements.\n\nOpen this link and sign in with a Yard account to join:\n${inviteLink(i.token)}\n\n` +
      `The link works once and expires on ${fmtDate(i.expires_at)}.`;
    return `mailto:${encodeURIComponent(i.email || "")}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(text)}`;
  }

  async function showLinks(invites) {
    await modal({
      title: invites.length === 1 ? "Invite link ready" : "Invite links ready",
      content: h(
        "div.stack",
        {},
        h("p.modal__text", {}, "Each link works once. Send it by email, text, or a note under the door."),
        invites.map((i) =>
          h(
            "div.linkbox",
            { "data-invite-link": i.email },
            h("span.linkbox__who", {}, i.email),
            h("input.input.mono.linkbox__url", {
              readonly: true,
              value: inviteLink(i.token),
              "aria-label": "Invite link for " + i.email,
              onfocus: (e) => e.target.select(),
            }),
            h(
              "span.linkbox__actions",
              {},
              h(
                "button.btn.btn--ghost.btn--sm",
                { type: "button", onclick: ctx.guard(() => copyLink(i)) },
                icon("copy"),
                "Copy",
              ),
              h("a.btn.btn--ghost.btn--sm", { href: mailto(i) }, icon("send"), "Email"),
            ),
          ),
        ),
      ),
      confirm: "Done",
      cancel: null,
      wide: true,
    });
  }

  async function addCharge() {
    const res = await modal({
      title: "Add a charge",
      content: h(
        "div.stack",
        {},
        field(
          "What for",
          select(
            "kind",
            [
              ["deposit", "Security deposit"],
              ["late_fee", "Late fee"],
              ["utilities", "Utilities"],
              ["other", "Something else"],
            ],
            "utilities",
          ),
        ),
        field("Label (optional)", input("label", { maxlength: 60, placeholder: "Water, September" })),
        h(
          "div.row2",
          {},
          field(
            "Amount",
            h(
              "span.money-input",
              {},
              h("span", {}, "$"),
              input("amount", { inputmode: "decimal", placeholder: "42.00" }),
            ),
          ),
          field("Due", input("due_on", { type: "date", value: todayISO() })),
        ),
      ),
      confirm: "Add charge",
      onSubmit: (form) => {
        const amount = parseMoney(form.elements.amount.value);
        if (!amount) throw new Error("Enter an amount, like 42 or 42.50.");
        return api(`api/leases/${lease.lease.id}/charges`, {
          method: "POST",
          body: {
            kind: form.elements.kind.value,
            label: form.elements.label.value,
            amount_cents: amount,
            due_on: form.elements.due_on.value,
          },
        });
      },
    });
    if (res) {
      toast("Charge added. The tenants see it now.");
      await refresh();
    }
  }

  async function voidCharge(item) {
    const ok = await confirmModal({
      title: "Void this charge?",
      body: `${item.label}, ${money(item.amount_cents)}, comes off the bill.`,
      confirm: "Void charge",
      danger: true,
    });
    if (!ok) return;
    await api(`api/leases/${lease.lease.id}/charges/${item.charge_id}`, { method: "DELETE" });
    toast("Charge voided.");
    await refresh();
  }

  async function recordPayment() {
    const open = lease.items.filter((i) => i.status !== "paid");
    const res = await modal({
      title: "Record a payment",
      content: h(
        "div.stack",
        {},
        h("p.modal__text", {}, "For rent paid outside Keyring, by cash or check. Tick what it covered."),
        h(
          "fieldset.checks",
          {},
          open.map((i) =>
            h(
              "label.check",
              {},
              h("input", { type: "checkbox", name: "ref", value: i.ref, checked: true }),
              h("span.check__label", {}, i.label),
              h("span.mono", {}, money(i.amount_cents)),
            ),
          ),
        ),
        field(
          "Paid by",
          select(
            "method",
            [
              ["check", "Check"],
              ["cash", "Cash"],
            ],
            "check",
          ),
        ),
      ),
      confirm: "Record payment",
      onSubmit: (form) => {
        const refs = [...form.querySelectorAll("input[name=ref]:checked")].map((x) => x.value);
        if (!refs.length) throw new Error("Tick at least one item.");
        const expected = open.filter((i) => refs.includes(i.ref)).reduce((s, i) => s + i.amount_cents, 0);
        return api(`api/leases/${lease.lease.id}/payments`, {
          method: "POST",
          body: { refs, expected_cents: expected, method: form.elements.method.value },
        });
      },
    });
    if (res) {
      toast(`Recorded ${money(res.total_cents)}.`);
      await refresh();
    }
  }

  await refresh();
  return { propertyId, refresh, onEvent };
}

function inviteLink(token) {
  return new URL("?invite=" + encodeURIComponent(token), location.href).href;
}

function paidLine(item) {
  const p = item.paid;
  const how = p.method === "card" ? "card •••• " + p.card_last4 : p.method;
  return `Paid ${fmtDay(p.paid_at)} by ${p.by_name || "someone"} · ${how}`;
}

/* -------------------------------------------------------------- settings */

export async function settings(ctx, propertyId) {
  const { body, property } = await propertyFrame(ctx, propertyId, "/settings");
  ctx.title("Settings · " + property.name);
  const canWrite = property.can_write;
  const ro = canWrite ? {} : { disabled: true };

  const form = h(
    "form.card",
    { novalidate: true },
    h("h2.card__title", {}, "Property details"),
    h("p.card__sub", {}, "The contact card appears on every tenant's home page."),
    h(
      "div.stack",
      {},
      field("Name", input("name", { value: property.name, maxlength: 80, ...ro })),
      field("Address", input("address", { value: property.address, maxlength: 160, ...ro })),
      h(
        "div.row3",
        {},
        field("Office phone", input("phone", { value: property.phone, maxlength: 30, ...ro })),
        field("Emergency line", input("emergency", { value: property.emergency, maxlength: 30, ...ro })),
        field("Office hours", input("hours", { value: property.hours, maxlength: 80, ...ro })),
      ),
    ),
    canWrite ? h("div.form__actions", {}, h("button.btn.btn--brass", { type: "submit" }, "Save changes")) : null,
  );
  form.addEventListener(
    "submit",
    ctx.guard(async (e) => {
      e.preventDefault();
      const v = (k) => form.elements[k].value;
      await api("api/properties/" + propertyId, {
        method: "PATCH",
        body: {
          name: v("name"),
          address: v("address"),
          phone: v("phone"),
          emergency: v("emergency"),
          hours: v("hours"),
        },
      });
      await ctx.refreshMe();
      toast("Saved.");
      ctx.go("#/l/p/" + propertyId + "/settings");
    }),
  );

  const danger = canWrite
    ? h(
        "section.danger",
        {},
        h(
          "div",
          {},
          h("h3", {}, "Delete this property"),
          h(
            "p",
            {},
            "Every unit, lease, payment, request and announcement is deleted, and every tenant loses access at once.",
          ),
        ),
        h("button.btn.btn--danger", { type: "button", onclick: ctx.guard(remove) }, icon("trash"), "Delete property"),
      )
    : null;

  async function remove() {
    const res = await modal({
      title: "Delete " + property.name + "?",
      content: h(
        "div.stack",
        {},
        h("p.modal__text", {}, "This can't be undone. Type the property's name to confirm."),
        field("Property name", input("confirm", { placeholder: property.name })),
      ),
      confirm: "Delete property",
      danger: true,
      onOpen: (dialog, f) => {
        const ok = f.querySelector("button[type=submit]");
        const check = () =>
          (ok.disabled = f.elements.confirm.value.trim().toLowerCase() !== property.name.toLowerCase());
        f.elements.confirm.addEventListener("input", check);
        check();
      },
      onSubmit: (f) =>
        api("api/properties/" + propertyId, { method: "DELETE", body: { confirm_name: f.elements.confirm.value } }),
    });
    if (!res) return;
    await ctx.refreshMe();
    toast(property.name + " was deleted.");
    ctx.go("#/l");
  }

  body.replaceChildren(...[form, danger].filter(Boolean));
  return { propertyId };
}
