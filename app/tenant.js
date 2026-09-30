// The tenant portal: home (the unit, the bill, what's new), and payments.
// Requests and announcements are shared views (tickets.js, notices.js) that
// borrow this file's frame.
//
// Everything a tenant sees hangs off one lease. The server scopes every read
// to the leases this person is on, so there is nothing to filter here.

import { api, ApiError } from "./api.js";
import {
  h,
  icon,
  keyTag,
  money,
  fmtDate,
  fmtDay,
  fmtMonth,
  plural,
  pill,
  avatar,
  prose,
  ago,
  signature,
  CATEGORIES,
} from "./ui.js";
import { openPay } from "./pay.js";

const TABS = [
  ["", "Home", "home"],
  ["/payments", "Payments", "card"],
  ["/requests", "Requests", "wrench"],
  ["/notices", "Announcements", "megaphone"],
];

/* ---------------------------------------------------------------- frame */

// A landlord who opens a tenant URL of their own property gets the same 404
// as a stranger: their side of the lease lives in the landlord portal.
export async function leaseFrame(ctx, leaseId, tab) {
  const lease = await api("api/leases/" + leaseId);
  if (lease.role !== "tenant") throw new ApiError("not found", 404, "not_found");
  const body = h("div.frame__body");
  const base = "#/t/" + leaseId;
  const others = ctx.me.leases.filter((l) => l.id !== leaseId);
  ctx.root.replaceChildren(
    h(
      "section.frame.frame--tenant",
      {},
      h(
        "header.frame__head",
        {},
        h("p.eyebrow", {}, "Your home"),
        h("h1.frame__name", {}, keyTag(lease.lease.unit_number, "lg"), h("span", {}, lease.property.name)),
        lease.property.address ? h("p.frame__sub", {}, lease.property.address) : null,
        others.length
          ? h(
              "p.frame__switch",
              {},
              "Also yours: ",
              others.map((l) => h("a", { href: "#/t/" + l.id }, `Unit ${l.unit_number}, ${l.property_name}`)),
            )
          : null,
      ),
      h(
        "nav.tabs",
        { "aria-label": "Your home" },
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
  return { body, lease };
}

/* ------------------------------------------------------------------ home */

export async function home(ctx, leaseId) {
  let { body, lease } = await leaseFrame(ctx, leaseId, "");
  const propertyId = lease.property.id;
  ctx.title("Unit " + lease.lease.unit_number);
  let drawn = "";

  async function refresh(fresh) {
    const [next, posts, requests] = await Promise.all([
      fresh ? Promise.resolve(fresh) : api("api/leases/" + leaseId),
      api(`api/properties/${propertyId}/announcements`),
      api(`api/properties/${propertyId}/tickets?status=open&lease=${leaseId}`),
    ]);
    if (ctx.stale()) return;
    const sig = signature([next, posts, requests]);
    if (sig === drawn) return;
    drawn = sig;
    lease = next;
    paint(posts, requests);
  }

  function paint(posts, requests) {
    const open = lease.items.filter((i) => i.status !== "paid");
    const overdue = open.filter((i) => i.status === "overdue");
    const p = lease.property;
    const roommates = lease.tenants.filter((t) => !t.is_you);

    const bill = lease.balance_cents
      ? h(
          "section.bill" + (overdue.length ? ".bill--late" : ""),
          { "data-bill": "due" },
          h("p.bill__label", {}, overdue.length ? "Overdue" : "You owe"),
          h("p.bill__amount.mono", {}, money(lease.balance_cents)),
          h(
            "p.bill__sub",
            {},
            open.length === 1
              ? `${open[0].label}, due ${fmtDate(open[0].due_at)}`
              : `${plural(open.length, "item")}, the oldest due ${fmtDate(open[0].due_at)}`,
          ),
          h(
            "div.bill__actions",
            {},
            h(
              "button.btn.btn--brass.btn--lg",
              { type: "button", onclick: ctx.guard(() => pay(open)) },
              icon("card"),
              "Pay " + money(lease.balance_cents),
            ),
            h("a.btn.btn--ghost", { href: `#/t/${leaseId}/payments` }, "See the bill"),
          ),
        )
      : h(
          "section.bill.bill--paid",
          { "data-bill": "paid" },
          h("p.bill__label", {}, icon("check"), "All paid up"),
          h("p.bill__amount.mono", {}, money(0)),
          h(
            "p.bill__sub",
            {},
            lease.next_rent
              ? `Next: ${fmtMonth(lease.next_rent.month, true)} rent, ${money(lease.next_rent.amount_cents)}, due ${fmtDate(lease.next_rent.due_at)}`
              : "Nothing coming up.",
          ),
          h("div.bill__actions", {}, h("a.btn.btn--ghost", { href: `#/t/${leaseId}/payments` }, "Payment history")),
        );

    const tag = h(
      "section.hanger",
      { "aria-label": "Your unit" },
      h("div.hanger__ring", { "aria-hidden": "true" }),
      h(
        "div.hanger__tag",
        {},
        h("span.hanger__hole"),
        h("span.hanger__label", {}, "Unit"),
        h("span.hanger__num", {}, lease.lease.unit_number),
      ),
      h(
        "dl.facts.facts--tight",
        {},
        h("div", {}, h("dt", {}, "Rent"), h("dd.mono", {}, money(lease.rent_cents) + " / mo")),
        h("div", {}, h("dt", {}, "Due"), h("dd", {}, "Day " + lease.lease.due_day)),
        h(
          "div",
          {},
          h("dt", {}, "Lease"),
          h("dd", {}, lease.lease.ends_at ? "Until " + fmtDate(lease.lease.ends_at) : "Month to month"),
        ),
      ),
    );

    const pinned = posts.filter((a) => a.pinned);
    const latest = [...pinned, ...posts.filter((a) => !a.pinned)].slice(0, 3);
    const news = h(
      "section.card",
      { "data-card": "news" },
      h(
        "div.card__head",
        {},
        h("h2.card__title", {}, "From your landlord"),
        h("a.card__more", { href: `#/t/${leaseId}/notices` }, "All announcements"),
      ),
      latest.length
        ? h(
            "ul.posts.posts--compact",
            {},
            latest.map((a) =>
              h(
                "li.post" + (a.pinned ? ".post--pinned" : ""),
                {},
                h(
                  "p.post__meta",
                  {},
                  a.pinned ? h("span.chip.chip--brass", {}, icon("pin"), "Pinned") : null,
                  h("span", {}, ago(a.posted_at)),
                ),
                h("h3.post__title", {}, a.title),
                a.body ? prose(a.body.length > 220 ? a.body.slice(0, 220) + "…" : a.body) : null,
              ),
            ),
          )
        : h("p.card__sub", {}, "No announcements yet."),
    );

    const fixes = h(
      "section.card",
      { "data-card": "requests" },
      h(
        "div.card__head",
        {},
        h("h2.card__title", {}, "Open requests"),
        h("a.btn.btn--ghost.btn--sm", { href: `#/t/${leaseId}/requests/new` }, icon("plus"), "New request"),
      ),
      requests.length
        ? h(
            "ul.tickets",
            {},
            requests
              .slice(0, 4)
              .map((t) =>
                h(
                  "li",
                  {},
                  h(
                    "a.ticket",
                    { href: `#/t/${leaseId}/requests/${t.id}` },
                    h("span.ticket__icon", {}, icon(CATEGORIES[t.category].icon)),
                    h("span.ticket__title", {}, t.title),
                    pill(t.status),
                  ),
                ),
              ),
          )
        : h("p.card__sub", {}, "Nothing open. Something broken? Tell your landlord here."),
    );

    const contact = h(
      "section.card.contact",
      { "data-card": "contact" },
      h("h2.card__title", {}, "Your landlord"),
      h("p.contact__name", {}, avatar(p.landlord_name, "landlord"), h("span", {}, p.landlord_name)),
      h(
        "ul.contact__list",
        {},
        p.phone
          ? h(
              "li",
              {},
              icon("phone"),
              h("span", {}, "Office "),
              h("a", { href: "tel:" + p.phone.replace(/[^\d+]/g, "") }, p.phone),
            )
          : null,
        p.emergency
          ? h(
              "li.contact__urgent",
              {},
              icon("alert"),
              h("span", {}, "Emergencies "),
              h("a", { href: "tel:" + p.emergency.replace(/[^\d+]/g, "") }, p.emergency),
            )
          : null,
        p.hours ? h("li", {}, icon("clock"), h("span", {}, p.hours)) : null,
      ),
      roommates.length
        ? h(
            "div.contact__roommates",
            {},
            h("h3.contact__sub", {}, "Roommates"),
            h(
              "ul.people.people--inline",
              {},
              roommates.map((t) => h("li.person", {}, avatar(t.name, t.user_id), h("span.person__name", {}, t.name))),
            ),
          )
        : null,
    );

    body.replaceChildren(
      h("div.home", {}, h("div.home__main", {}, bill, news, fixes), h("div.home__side", {}, tag, contact)),
    );
  }

  async function pay(items) {
    const res = await openPay(ctx, lease, items);
    if (res) await refresh();
  }

  await refresh(lease);
  return { propertyId, refresh: () => refresh() };
}

/* -------------------------------------------------------------- payments */

export async function payments(ctx, leaseId) {
  let { body, lease } = await leaseFrame(ctx, leaseId, "/payments");
  const propertyId = lease.property.id;
  ctx.title("Payments · Unit " + lease.lease.unit_number);
  let drawn = "";

  async function refresh(fresh) {
    const next = fresh || (await api("api/leases/" + leaseId));
    if (ctx.stale()) return;
    const sig = signature(next);
    if (sig === drawn) return;
    drawn = sig;
    lease = next;
    paint();
  }

  function paint() {
    const open = lease.items.filter((i) => i.status !== "paid");
    const paid = lease.items.filter((i) => i.status === "paid");

    let due;
    if (open.length) {
      const total = h("strong.mono", {}, money(lease.balance_cents));
      const button = h("button.btn.btn--brass", { type: "submit" }, icon("card"), "Pay selected");
      due = h(
        "form.card.due",
        { "data-card": "due", novalidate: true },
        h("div.card__head", {}, h("h2.card__title", {}, "To pay"), h("p.due__total", {}, "Selected: ", total)),
        h(
          "ul.checks",
          {},
          open.map((i) =>
            h(
              "li",
              {},
              h(
                "label.check.check--row",
                {},
                h("input", { type: "checkbox", name: "ref", value: i.ref, checked: true }),
                h("span.check__label", {}, i.label, h("span.item__meta", {}, "Due " + fmtDate(i.due_at))),
                pill(i.status),
                h("span.mono", {}, money(i.amount_cents)),
              ),
            ),
          ),
        ),
        h("div.form__actions", {}, button),
      );
      const picked = () => open.filter((i) => due.querySelector(`input[value="${CSS.escape(i.ref)}"]`).checked);
      due.addEventListener("change", () => {
        const items = picked();
        total.textContent = money(items.reduce((s, i) => s + i.amount_cents, 0));
        button.disabled = !items.length;
      });
      due.addEventListener(
        "submit",
        ctx.guard(async (e) => {
          e.preventDefault();
          const res = await openPay(ctx, lease, picked());
          if (res) await refresh();
        }),
      );
    } else {
      due = h(
        "section.card.due.due--clear",
        { "data-card": "due" },
        h("h2.card__title", {}, icon("check"), "Nothing to pay"),
        h(
          "p.card__sub",
          {},
          lease.next_rent
            ? `${fmtMonth(lease.next_rent.month)} rent, ${money(lease.next_rent.amount_cents)}, is due ${fmtDate(lease.next_rent.due_at)}.`
            : "You're all caught up.",
        ),
      );
    }

    // One row per confirmation code: a "pay all" is one receipt.
    const receipts = new Map();
    for (const item of paid) {
      const code = item.paid.confirmation;
      if (!receipts.has(code)) receipts.set(code, { code, paid: item.paid, items: [], total: 0 });
      const r = receipts.get(code);
      r.items.push(item);
      r.total += item.amount_cents;
    }
    const history = h(
      "section.card",
      { "data-card": "history" },
      h("h2.card__title", {}, "History"),
      receipts.size
        ? h(
            "ul.receipts",
            {},
            [...receipts.values()]
              .sort((a, b) => b.paid.paid_at - a.paid.paid_at)
              .map((r) =>
                h(
                  "li",
                  {},
                  h(
                    "a.receipt-row",
                    { href: `#/r/${leaseId}/${r.code}` },
                    h("span.receipt-row__date.mono", {}, fmtDay(r.paid.paid_at)),
                    h(
                      "span.receipt-row__what",
                      {},
                      r.items.map((i) => i.label).join(", "),
                      h(
                        "span.item__meta",
                        {},
                        (r.paid.method === "card"
                          ? "Card •••• " + r.paid.card_last4
                          : r.paid.method === "cash"
                            ? "Cash"
                            : "Check") +
                          " · " +
                          (r.paid.by_name || "") +
                          " · " +
                          r.code,
                      ),
                    ),
                    h("span.mono", {}, money(r.total)),
                    icon("next"),
                  ),
                ),
              ),
          )
        : h("p.card__sub", {}, "No payments yet."),
    );

    body.replaceChildren(h("div.stack.stack--lg", {}, due, history));
  }

  await refresh(lease);
  return { propertyId, refresh: () => refresh() };
}
