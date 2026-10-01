// Announcements: a property-wide notice board. The landlord posts, pins and
// deletes; every tenant in the property reads, and a new post reaches open
// tabs at once. Bodies are plain text with paragraphs and links (ui.prose),
// never HTML.

import { api } from "./api.js";
import { h, icon, ago, prose, toast, confirmModal, signature } from "./ui.js";
import { propertyFrame } from "./landlord.js";
import { leaseFrame } from "./tenant.js";

export async function view(ctx, portal, id) {
  let body;
  let propertyId;
  let canWrite = false;
  if (portal === "l") {
    const frame = await propertyFrame(ctx, id, "/notices");
    body = frame.body;
    propertyId = id;
    canWrite = frame.property.can_write;
    ctx.title("Announcements · " + frame.property.name);
  } else {
    const frame = await leaseFrame(ctx, id, "/notices");
    body = frame.body;
    propertyId = frame.lease.property.id;
    ctx.title("Announcements · " + frame.lease.property.name);
  }

  const listBox = h("div.list");
  let drawn = "";

  // The composer is built once and never repainted, so a live update can't
  // eat a half-written post.
  const composer = canWrite ? buildComposer() : null;
  body.replaceChildren(...[composer, listBox].filter(Boolean));

  function buildComposer() {
    const form = h(
      "form.card.composer-card",
      { novalidate: true },
      h("h2.card__title", {}, "Post an announcement"),
      h(
        "label.field",
        {},
        h("span.field__label", {}, "Title"),
        h("input.input", {
          name: "title",
          maxlength: 120,
          placeholder: "Water off Friday, 9 to noon",
          autocomplete: "off",
        }),
      ),
      h(
        "label.field",
        {},
        h("span.field__label", {}, "Message"),
        h("textarea.input.input--area", {
          name: "body",
          rows: 4,
          maxlength: 4000,
          placeholder: "Every tenant in the building sees this on their home page.",
        }),
      ),
      h(
        "div.form__actions.form__actions--split",
        {},
        h(
          "label.check",
          {},
          h("input", { type: "checkbox", name: "pinned" }),
          h("span.check__label", {}, "Pin to the top"),
        ),
        h("button.btn.btn--primary", { type: "submit" }, icon("megaphone"), "Post to all tenants"),
      ),
    );
    form.addEventListener(
      "submit",
      ctx.guard(async (e) => {
        e.preventDefault();
        const title = form.elements.title.value.trim();
        if (!title) return toast("Give the announcement a title.", "error");
        await api(`api/properties/${propertyId}/announcements`, {
          method: "POST",
          body: { title, body: form.elements.body.value, pinned: form.elements.pinned.checked },
        });
        form.reset();
        toast("Posted. Your tenants see it now.");
        await refresh();
      }),
    );
    return form;
  }

  async function refresh() {
    const posts = await api(`api/properties/${propertyId}/announcements`);
    if (ctx.stale()) return;
    const sig = signature(posts);
    if (sig === drawn) return;
    drawn = sig;
    if (!posts.length) {
      listBox.replaceChildren(
        h(
          "div.empty.empty--inline",
          {},
          h(
            "p",
            {},
            portal === "l"
              ? "Nothing posted yet. Announcements reach every tenant's home page."
              : "Your landlord hasn't posted anything yet.",
          ),
        ),
      );
      return;
    }
    listBox.replaceChildren(
      h(
        "ul.posts",
        {},
        posts.map((a) =>
          h(
            "li.post.card" + (a.pinned ? ".post--pinned" : ""),
            { "data-post": a.id },
            h(
              "p.post__meta",
              {},
              a.pinned ? h("span.chip.chip--accent", {}, icon("pin"), "Pinned") : null,
              h("span", {}, `${a.author_name || "Your landlord"} · ${ago(a.posted_at)}`),
            ),
            h("h2.post__title", {}, a.title),
            a.body ? prose(a.body) : null,
            canWrite
              ? h(
                  "div.post__actions",
                  {},
                  h(
                    "button.btn.btn--ghost.btn--sm",
                    { type: "button", onclick: ctx.guard(() => pin(a)) },
                    icon("pin"),
                    a.pinned ? "Unpin" : "Pin",
                  ),
                  h(
                    "button.btn.btn--danger-ghost.btn--sm",
                    { type: "button", onclick: ctx.guard(() => remove(a)) },
                    icon("trash"),
                    "Delete",
                  ),
                )
              : null,
          ),
        ),
      ),
    );
  }

  async function pin(a) {
    await api(`api/properties/${propertyId}/announcements/${a.id}`, { method: "PATCH", body: { pinned: !a.pinned } });
    await refresh();
  }

  async function remove(a) {
    const ok = await confirmModal({
      title: "Delete this announcement?",
      body: `“${a.title}” disappears for every tenant.`,
      confirm: "Delete",
      danger: true,
    });
    if (!ok) return;
    await api(`api/properties/${propertyId}/announcements/${a.id}`, { method: "DELETE" });
    await refresh();
  }

  // Only announcements change this page.
  function onEvent(e) {
    return !e.t.startsWith("announcement.");
  }

  await refresh();
  return { propertyId, refresh, onEvent };
}
