// Simulated checkout and receipts. Keyring is a demo: no payment provider is
// involved and no money moves.
//
// The card form never sends a card number anywhere. This file maps the two
// published test numbers to tokens, and only the token goes to the server:
//   4242 4242 4242 4242   tok_visa             approved
//   4000 0000 0000 0002   tok_chargeDeclined   declined
// Anything else is refused right here. The inputs have no name and
// autocomplete is off, so the browser doesn't offer to save them either.

import { api } from "./api.js";
import { h, icon, money, fmtDate, keyTag, modal, toast } from "./ui.js";

const TEST_CARDS = {
  4242424242424242: "tok_visa",
  4000000000000002: "tok_chargeDeclined",
};

const PROCESSING_MS = 900;

// Resolves with the payment ({ confirmation, total_cents, … }) or null.
export async function openPay(ctx, lease, items) {
  if (!items.length) return null;
  const total = items.reduce((sum, i) => sum + i.amount_cents, 0);
  const number = cardInput("4242 4242 4242 4242", "Card number", "cc-number-demo", 23);
  const expiry = cardInput("12 / 34", "Expiry", "cc-exp-demo", 7);
  const cvc = cardInput("123", "CVC", "cc-cvc-demo", 4);
  number.addEventListener("input", () => {
    const digits = number.value.replace(/\D/g, "").slice(0, 19);
    number.value = digits.replace(/(\d{4})(?=\d)/g, "$1 ");
  });
  const fill = (digits) => () => {
    number.value = digits.replace(/(\d{4})(?=\d)/g, "$1 ");
    number.focus();
  };

  const content = h(
    "div.pay",
    {},
    h(
      "div.pay__demo",
      { role: "note" },
      icon("alert"),
      h(
        "div",
        {},
        h("strong", {}, "Demo checkout. "),
        "Nothing is charged, and the card number never leaves this page. Use a test card:",
        h(
          "div.pay__cards",
          {},
          h(
            "button.testcard",
            { type: "button", onclick: fill("4242424242424242") },
            h("span.mono", {}, "4242 4242 4242 4242"),
            h("span", {}, "approves"),
          ),
          h(
            "button.testcard",
            { type: "button", onclick: fill("4000000000000002") },
            h("span.mono", {}, "4000 0000 0000 0002"),
            h("span", {}, "declines"),
          ),
        ),
      ),
    ),
    h(
      "ul.pay__items",
      {},
      items.map((i) => h("li", {}, h("span", {}, i.label), h("span.mono", {}, money(i.amount_cents)))),
      h("li.pay__total", {}, h("span", {}, "Total"), h("strong.mono", {}, money(total))),
    ),
    h(
      "div.pay__card",
      {},
      h("label.field", {}, h("span.field__label", {}, "Card number"), number),
      h(
        "div.row2",
        {},
        h("label.field", {}, h("span.field__label", {}, "Expiry"), expiry),
        h("label.field", {}, h("span.field__label", {}, "CVC"), cvc),
      ),
    ),
  );

  const result = await modal({
    title: `Pay rent for unit ${lease.lease.unit_number}`,
    content,
    confirm: "Pay " + money(total),
    onSubmit: async (form) => {
      const token = TEST_CARDS[number.value.replace(/\D/g, "")];
      if (!token)
        throw new Error(
          "Use one of the test cards above. This is a demo, so real cards are refused before anything is sent.",
        );
      const ok = form.querySelector("button[type=submit]");
      ok.textContent = "Processing…";
      await new Promise((r) => setTimeout(r, PROCESSING_MS));
      try {
        return await api(`api/leases/${lease.lease.id}/payments`, {
          method: "POST",
          body: { refs: items.map((i) => i.ref), expected_cents: total, method: "card", card: token },
        });
      } catch (err) {
        if (err.code === "card_declined")
          throw new Error("Declined. That's what the 4000 … 0002 test card does; try 4242 4242 4242 4242.");
        if (err.code === "already_paid" || err.code === "items_changed" || err.code === "amount_changed") {
          toast("Your bill changed a moment ago (maybe a roommate paid). Take another look.", "error");
          return { changed: true };
        }
        throw err;
      } finally {
        ok.textContent = "Pay " + money(total);
      }
    },
  });
  if (!result || result.changed) return result;

  await modal({
    title: "Payment complete",
    content: h(
      "div.paid",
      { "data-paid": result.confirmation },
      h("span.paid__check", {}, icon("check")),
      h("p.paid__amount.mono", {}, money(result.total_cents)),
      h(
        "p.paid__sub",
        {},
        result.skipped.length
          ? "Paid. Part of it had just been paid by someone else, so it wasn't charged twice."
          : "Paid, in pretend money.",
      ),
      h("p.paid__code", {}, "Confirmation ", h("strong.mono", {}, result.confirmation)),
      h("a.btn.btn--ghost", { href: `#/r/${lease.lease.id}/${result.confirmation}` }, icon("receipt"), "View receipt"),
    ),
    confirm: "Done",
    cancel: null,
  });
  return result;
}

function cardInput(placeholder, label, id, max) {
  return h("input.input.mono", {
    id,
    value: placeholder,
    inputmode: "numeric",
    autocomplete: "off",
    spellcheck: "false",
    maxlength: max,
    "aria-label": label,
    "data-lpignore": "true",
  });
}

/* --------------------------------------------------------------- receipt */

export async function receiptView(ctx, leaseId, code) {
  const r = await api(`api/leases/${leaseId}/receipts/${code}`);
  ctx.title("Receipt " + code);
  const method =
    r.method === "card"
      ? "Test card •••• " + r.card_last4
      : r.method === "cash"
        ? "Cash (recorded by the landlord)"
        : "Check (recorded by the landlord)";
  ctx.root.replaceChildren(
    h(
      "section.receipt-page",
      {},
      h(
        "div.receipt-page__bar",
        {},
        h("button.btn.btn--ghost", { type: "button", onclick: () => history.back() }, icon("back"), "Back"),
        h("button.btn.btn--ghost", { type: "button", onclick: () => window.print() }, icon("print"), "Print"),
      ),
      h(
        "article.receipt",
        { "data-receipt": code },
        h("p.receipt__stamp", { "aria-label": "Demo receipt: no money moved" }, "Demo receipt · no money moved"),
        h(
          "header.receipt__head",
          {},
          keyTag(r.unit_number, "lg"),
          h(
            "div",
            {},
            h("h1.receipt__title", {}, r.property.name),
            r.property.address ? h("p.receipt__addr", {}, r.property.address) : null,
          ),
        ),
        h(
          "dl.facts",
          {},
          h("div", {}, h("dt", {}, "Confirmation"), h("dd.mono", {}, r.confirmation)),
          h("div", {}, h("dt", {}, "Paid"), h("dd", {}, fmtDate(r.paid_at))),
          h("div", {}, h("dt", {}, "By"), h("dd", {}, r.paid_by_name || "—")),
          h("div", {}, h("dt", {}, "Method"), h("dd", {}, method)),
        ),
        h(
          "ul.receipt__lines",
          {},
          r.lines.map((l) => h("li", {}, h("span", {}, l.label), h("span.mono", {}, money(l.amount_cents)))),
          h("li.receipt__total", {}, h("span", {}, "Total"), h("strong.mono", {}, money(r.total_cents))),
        ),
        h(
          "p.receipt__foot",
          {},
          "Keyring is a demo project. This receipt records a simulated payment; no card was charged and no money changed hands.",
        ),
      ),
    ),
  );
  return {};
}
