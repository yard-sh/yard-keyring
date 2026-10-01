// Maintenance requests, for both portals. Tenants file them and talk in
// their thread; the landlord moves them along (submitted, acknowledged, in
// progress, resolved) and talks back. "Tickets" in code, requests on screen.
//
// A thread is live: comments and typing arrive over the property's socket
// and are applied here directly; status changes arrive as a hint and the
// thread re-fetches. The composer is never repainted, so a live update can't
// eat a half-written comment.

import { api } from "./api.js";
import {
  h,
  icon,
  keyTag,
  ago,
  plural,
  pill,
  avatar,
  prose,
  toast,
  confirmModal,
  signature,
  CATEGORIES,
  STATUS_LABEL,
} from "./ui.js";
import { propertyFrame } from "./landlord.js";
import { leaseFrame } from "./tenant.js";

const FLOW = ["submitted", "acknowledged", "in_progress", "resolved"];
const TYPING_SHOWN_MS = 4000;

async function frameFor(ctx, portal, id, tab) {
  if (portal === "l") {
    const { body, property } = await propertyFrame(ctx, id, tab);
    return { body, propertyId: id, base: `#/l/p/${id}/requests`, leaseId: null, place: property };
  }
  const { body, lease } = await leaseFrame(ctx, id, tab);
  return { body, propertyId: lease.property.id, base: `#/t/${id}/requests`, leaseId: id, place: lease.property, lease };
}

/* ------------------------------------------------------------------ list */

export async function list(ctx, portal, id) {
  const frame = await frameFor(ctx, portal, id, "/requests");
  ctx.title("Requests · " + frame.place.name);
  let filter = "open";
  const chips = h("div.chips", { role: "group", "aria-label": "Show" });
  const listBox = h("div.list");
  const head = h(
    "div.section__head",
    {},
    chips,
    portal === "t" ? h("a.btn.btn--primary", { href: `${frame.base}/new` }, icon("plus"), "New request") : null,
  );
  frame.body.replaceChildren(head, listBox);

  function paintChips() {
    chips.replaceChildren(
      ...[
        ["open", "Open"],
        ["resolved", "Resolved"],
        ["all", "All"],
      ].map(([value, label]) =>
        h(
          "button.chip-toggle",
          {
            type: "button",
            "aria-pressed": String(value === filter),
            onclick: () => {
              filter = value;
              paintChips();
              refresh().catch(ctx.report);
            },
          },
          label,
        ),
      ),
    );
  }

  async function refresh() {
    const query = `status=${filter}` + (frame.leaseId ? `&lease=${frame.leaseId}` : "");
    const rows = await api(`api/properties/${frame.propertyId}/tickets?${query}`);
    if (ctx.stale()) return;
    if (!rows.length) {
      listBox.replaceChildren(
        h(
          "div.empty.empty--inline",
          {},
          h(
            "p",
            {},
            filter === "open"
              ? portal === "l"
                ? "No open requests. Quiet week."
                : "Nothing open. If something breaks, file a request and your landlord sees it at once."
              : "Nothing here yet.",
          ),
        ),
      );
      return;
    }
    listBox.replaceChildren(
      h(
        "ul.tickets.tickets--full",
        {},
        rows.map((t) =>
          h(
            "li",
            {},
            h(
              "a.ticket",
              { href: `${frame.base}/${t.id}`, "data-ticket": t.id },
              h("span.ticket__icon", {}, icon(CATEGORIES[t.category].icon)),
              h(
                "span.ticket__main",
                {},
                h("span.ticket__title", {}, t.title),
                h(
                  "span.ticket__meta",
                  {},
                  portal === "l" ? keyTag(t.unit_number, "sm") : null,
                  h("span", {}, `${t.created_by_name} · ${ago(t.updated_at)}`),
                  t.comment_count ? h("span", {}, " · " + plural(t.comment_count, "comment")) : null,
                ),
              ),
              pill(t.status),
            ),
          ),
        ),
      ),
    );
  }

  paintChips();
  await refresh();
  return { propertyId: frame.propertyId, refresh };
}

/* ---------------------------------------------------------------- create */

export async function create(ctx, leaseId) {
  const frame = await frameFor(ctx, "t", leaseId, "/requests");
  ctx.title("New request");
  const p = frame.lease.property;
  const form = h(
    "form.card.newticket",
    { novalidate: true },
    h("a.crumb", { href: frame.base }, icon("back"), "Requests"),
    h("h2.card__title", {}, "What needs fixing?"),
    p.emergency
      ? h(
          "p.note.note--urgent",
          {},
          icon("alert"),
          "Flooding, no heat, gas smell or no power? Don't wait on a request: call ",
          h("a", { href: "tel:" + p.emergency.replace(/[^\d+]/g, "") }, p.emergency),
          ".",
        )
      : null,
    h(
      "fieldset.cats",
      {},
      h("legend.field__label", {}, "Category"),
      Object.entries(CATEGORIES).map(([value, c], i) =>
        h(
          "label.cat",
          {},
          h("input", { type: "radio", name: "category", value, checked: i === 0 }),
          icon(c.icon),
          h("span", {}, c.label),
        ),
      ),
    ),
    h(
      "label.field",
      {},
      h("span.field__label", {}, "In a few words"),
      h("input.input", { name: "title", maxlength: 120, placeholder: "Kitchen sink drips", autocomplete: "off" }),
    ),
    h(
      "label.field",
      {},
      h("span.field__label", {}, "Details (optional)"),
      h("textarea.input.input--area", {
        name: "body",
        rows: 4,
        maxlength: 2000,
        placeholder: "Since when, where exactly, anything you've tried.",
      }),
    ),
    h(
      "label.check",
      {},
      h("input", { type: "checkbox", name: "entry_ok", checked: true }),
      h("span.check__label", {}, "OK to come in when nobody's home"),
    ),
    h("p.form__error", { role: "alert", hidden: true }),
    h(
      "div.form__actions",
      {},
      h("a.btn.btn--ghost", { href: frame.base }, "Cancel"),
      h("button.btn.btn--primary", { type: "submit" }, icon("send"), "Send to landlord"),
    ),
  );
  form.addEventListener(
    "submit",
    ctx.guard(async (e) => {
      e.preventDefault();
      const error = form.querySelector(".form__error");
      error.hidden = true;
      try {
        const made = await api(`api/leases/${leaseId}/tickets`, {
          method: "POST",
          body: {
            category: form.elements.category.value,
            title: form.elements.title.value,
            body: form.elements.body.value,
            entry_ok: form.elements.entry_ok.checked,
          },
        });
        toast("Sent. Your landlord can see it now.");
        ctx.go(`${frame.base}/${made.id}`);
      } catch (err) {
        error.textContent = err.message.charAt(0).toUpperCase() + err.message.slice(1) + ".";
        error.hidden = false;
      }
    }),
  );
  frame.body.replaceChildren(form);
  return { propertyId: frame.propertyId, onEvent: () => true };
}

/* ---------------------------------------------------------------- detail */

export async function detail(ctx, portal, id, ticketId) {
  const frame = await frameFor(ctx, portal, id, "/requests");
  const me = ctx.me.user_id;
  let data = null;
  let drawn = "";
  const shown = new Set(); // comment ids on screen
  const typers = new Map(); // user_id → { name, timer }

  const head = h("div.tdetail__head");
  const thread = h("ol.thread", { "aria-live": "polite" });
  const typingLine = h("p.typing", { hidden: true });
  const box = h("textarea.input.input--area.composer__input", {
    rows: 2,
    maxlength: 2000,
    placeholder: "Write a reply…",
    "aria-label": "Reply",
  });
  const send = h("button.btn.btn--primary", { type: "submit" }, icon("send"), "Send");
  const composer = h("form.composer", { novalidate: true }, box, send);
  frame.body.replaceChildren(
    h("a.crumb", { href: frame.base }, icon("back"), "All requests"),
    h("div.tdetail", {}, head, h("section.card.thread-card", {}, thread, typingLine, composer)),
  );

  async function refresh() {
    const next = await api("api/tickets/" + ticketId);
    if (ctx.stale()) return;
    const sig = signature(next);
    if (sig === drawn) return;
    drawn = sig;
    data = next;
    ctx.title(data.ticket.title);
    paintHead();
    paintThread();
  }

  function paintHead() {
    const t = data.ticket;
    const cat = CATEGORIES[t.category];
    const control =
      portal === "l"
        ? h(
            "div.flow",
            { role: "group", "aria-label": "Status" },
            FLOW.map((s) =>
              h(
                "button.flow__step",
                {
                  type: "button",
                  "aria-pressed": String(s === t.status),
                  "data-status": s,
                  disabled: !data.can_write || s === t.status,
                  onclick: ctx.guard(() => setStatus(s)),
                },
                STATUS_LABEL[s],
              ),
            ),
          )
        : h(
            "ol.flow.flow--read",
            { "aria-label": "Progress" },
            FLOW.map((s) =>
              h(
                "li.flow__step",
                {
                  "aria-current": s === t.status ? "step" : null,
                  "data-done": String(FLOW.indexOf(s) <= FLOW.indexOf(t.status)),
                },
                STATUS_LABEL[s],
              ),
            ),
          );
    // replaceChildren would print a null as "null"; h() skips them.
    head.replaceChildren(
      ...[
        h(
          "div.tdetail__title",
          {},
          h("span.ticket__icon.ticket__icon--lg", {}, icon(cat.icon)),
          h(
            "div",
            {},
            h("h2.tdetail__name", {}, t.title),
            h(
              "p.tdetail__meta",
              {},
              keyTag(t.unit_number, "sm"),
              h("span", {}, `${cat.label} · filed by ${t.created_by_name} · ${ago(t.created_at)}`),
            ),
          ),
          pill(t.status),
        ),
        t.body ? prose(t.body) : null,
        h(
          "p.tdetail__entry",
          {},
          icon(t.entry_ok ? "key" : "clock"),
          t.entry_ok ? "OK to come in when nobody's home." : "Please arrange a time before coming in.",
        ),
        control,
        data.can_withdraw
          ? h(
              "button.btn.btn--danger-ghost.btn--sm",
              { type: "button", onclick: ctx.guard(withdraw) },
              "Withdraw request",
            )
          : null,
      ].filter(Boolean),
    );
  }

  function paintThread() {
    shown.clear();
    thread.replaceChildren(...data.events.map(eventNode));
    if (!data.events.some((e) => e.kind === "comment")) thread.append(h("li.thread__empty", {}, "No messages yet."));
  }

  function eventNode(e) {
    if (e.kind === "status") {
      const who = e.author_id === me ? "You" : e.author_name;
      const what =
        e.status === "submitted" ? "filed this request" : `marked it ${STATUS_LABEL[e.status].toLowerCase()}`;
      return h(
        "li.thread__status",
        {},
        h("span.thread__dot"),
        h("span", {}, `${who} ${what}`),
        h("time", {}, ago(e.at)),
      );
    }
    shown.add(e.id);
    const mine = e.author_id === me;
    return h(
      "li.bubble" + (mine ? ".bubble--mine" : "") + (e.role === "landlord" ? ".bubble--landlord" : ""),
      { "data-comment": e.id },
      mine ? null : avatar(e.author_name, e.author_id, "sm"),
      h(
        "div.bubble__body",
        {},
        h(
          "p.bubble__who",
          {},
          mine ? "You" : e.author_name,
          e.role === "landlord" ? h("span.chip.chip--accent", {}, "Landlord") : null,
          h("time", {}, ago(e.at)),
        ),
        prose(e.body),
      ),
    );
  }

  function addComment(comment) {
    if (!data || shown.has(comment.id)) return;
    const empty = thread.querySelector(".thread__empty");
    if (empty) empty.remove();
    thread.append(eventNode({ ...comment, kind: "comment" }));
    clearTyping(comment.author_id);
  }

  function showTyping(userId, name) {
    if (userId === me) return;
    clearTimeout(typers.get(userId)?.timer);
    typers.set(userId, { name, timer: setTimeout(() => clearTyping(userId), TYPING_SHOWN_MS) });
    paintTyping();
  }

  function clearTyping(userId) {
    const t = typers.get(userId);
    if (!t) return;
    clearTimeout(t.timer);
    typers.delete(userId);
    paintTyping();
  }

  function paintTyping() {
    const names = [...typers.values()].map((t) => t.name);
    typingLine.hidden = !names.length;
    typingLine.textContent = names.length === 1 ? `${names[0]} is typing…` : `${names.join(" and ")} are typing…`;
  }

  box.addEventListener("input", () => {
    if (data && box.value.trim()) ctx.live.typing(ticketId, data.ticket.lease_id);
  });
  box.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      composer.requestSubmit();
    }
  });
  composer.addEventListener(
    "submit",
    ctx.guard(async (e) => {
      e.preventDefault();
      const text = box.value.trim();
      if (!text) return;
      send.disabled = true;
      try {
        const comment = await api(`api/tickets/${ticketId}/comments`, { method: "POST", body: { body: text } });
        box.value = "";
        addComment(comment);
      } finally {
        send.disabled = false;
        box.focus();
      }
    }),
  );

  async function setStatus(status) {
    await api("api/tickets/" + ticketId, { method: "PATCH", body: { status } });
    await refresh();
  }

  async function withdraw() {
    const ok = await confirmModal({
      title: "Withdraw this request?",
      body: "It disappears for you and your landlord.",
      confirm: "Withdraw",
      danger: true,
    });
    if (!ok) return;
    await api("api/tickets/" + ticketId, { method: "DELETE" });
    toast("Request withdrawn.");
    ctx.go(frame.base);
  }

  function onEvent(e) {
    if (e.t === "comment" && e.ticket_id === ticketId) {
      addComment(e.comment);
      return true;
    }
    if (e.t === "typing" && e.ticket_id === ticketId) {
      showTyping(e.user_id, e.name);
      return true;
    }
    if (e.t === "ticket.withdrawn" && e.id === ticketId) {
      toast("This request was withdrawn.");
      ctx.go(frame.base);
      return true;
    }
    if (e.t === "ticket.updated" && e.id === ticketId) return false; // re-fetch
    return true; // nothing else changes this page
  }

  await refresh();
  return { propertyId: frame.propertyId, refresh, onEvent };
}
