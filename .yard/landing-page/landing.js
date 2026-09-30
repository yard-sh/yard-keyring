// Keyring landing page.
//
// Who is looking comes from Yard Auth, never from code in this repo. One
// session covers the page and every service of the project:
//   app/__yard/auth/me                always 200: { authenticated, user_id, email, ... }
//   app/api/me                        the app's own profile: name, properties, leases
//   __yard/auth/logout?return=/       ends the Keyring session, not the Yard
//                                     account, and comes back to this page
// Signing in needs no endpoint of its own: the app is access=authenticated,
// so following a link to app/ sends an anonymous visitor through Yard Auth
// and back into the app. The login buttons also remember which portal was
// asked for (keyring.portal), because the #hash may not survive a first
// sign-in's consent screen; the app reads it when it boots.
//
// window.yard (injected by the edge through embed.js) supplies the Yard
// avatar and the pricing tier. Every URL is relative so the page works at
// <username>.yard.sh/keyring/, inside a /@sandbox/, and on a custom domain.
(function () {
  "use strict";

  // Resolve against the directory the page is served from, even when the URL
  // arrives without its trailing slash (/keyring rather than /keyring/).
  var base = location.href.split(/[?#]/)[0];
  if (!/\/$/.test(base) && !/\.html?$/.test(base)) base += "/";
  var APP = new URL("app/", base).href;
  var LOGOUT = new URL("__yard/auth/logout?return=/", base).href;
  var PORTAL_HASH = { l: "#/l", t: "#/t" };

  var PEOPLE = ["#2F7A5B", "#B7791F", "#3D6A99", "#A2513B", "#6C5A9C", "#557A2E"];

  function el(tag, attrs, kids) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === "text") node.textContent = attrs[k];
      else if (attrs[k] != null) node.setAttribute(k, attrs[k]);
    });
    (kids || []).forEach(function (kid) {
      if (kid) node.appendChild(kid);
    });
    return node;
  }

  // Same hash and palette as the app (ui.js colorOf), so a person's colour
  // matches in both.
  function colorOf(id) {
    var h = 0;
    for (var i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
    return PEOPLE[h % PEOPLE.length];
  }

  function avatar(who) {
    if (who.avatarUrl) return el("img", { class: "av", src: who.avatarUrl, alt: "", width: "30", height: "30" });
    var node = el("span", { class: "av", text: (who.name || "?").trim().charAt(0).toUpperCase() || "?" });
    node.style.setProperty("--c", colorOf(who.id || who.name));
    return node;
  }

  /* ------------------------------------------------------------ portals */

  // Every login link goes to the app with its portal in the hash, and
  // remembers the choice for after sign-in.
  function portalLink(node, portal) {
    node.href = APP + PORTAL_HASH[portal];
    node.dataset.portal = portal;
  }

  document.querySelectorAll("a[data-portal]").forEach(function (a) {
    portalLink(a, a.dataset.portal);
  });

  document.addEventListener("click", function (e) {
    var link = e.target.closest && e.target.closest("a[data-portal]");
    if (!link) return;
    try {
      localStorage.setItem("keyring.portal", link.dataset.portal);
    } catch (err) {}
  });

  /* --------------------------------------------------------------- auth */

  async function getJSON(url) {
    try {
      var res = await fetch(url, {
        credentials: "same-origin",
        headers: { Accept: "application/json" },
        redirect: "error", // a gate redirect means "not signed in", not data
      });
      if (!res.ok) return null;
      return await res.json();
    } catch (err) {
      return null;
    }
  }

  async function ownership() {
    try {
      if (window.yard && typeof window.yard.ownership === "function") return await window.yard.ownership();
    } catch (err) {}
    return null;
  }

  async function whoIsHere() {
    var results = await Promise.all([getJSON(new URL("__yard/auth/me", APP)), ownership()]);
    var session = results[0];
    var yardUser = results[1] && results[1].signed_in ? results[1].user : null;
    if (!session || !session.authenticated) return null;

    // The app's own profile: the name people see, and which portals apply.
    var profile = await getJSON(new URL("api/me", APP));
    return {
      id: session.user_id || "",
      name: (profile && profile.name) || (session.email ? session.email.split("@")[0] : "") || "you",
      email: session.email || "",
      entitlement: session.entitlement || "none",
      avatarUrl: yardUser && yardUser.avatar_url ? yardUser.avatar_url : "",
      landlord: !!(profile && (profile.landlord_plan || (profile.properties && profile.properties.length))),
      tenant: !!(profile && profile.leases && profile.leases.length),
    };
  }

  var slot = document.getElementById("auth");

  function renderSignedOut() {
    var tenant = el("a", { class: "btn btn--ghost btn--sm", text: "Tenant login" });
    var landlord = el("a", { class: "btn btn--brass btn--sm", text: "Landlord login" });
    portalLink(tenant, "t");
    portalLink(landlord, "l");
    slot.replaceChildren(tenant, landlord);
  }

  function renderSignedIn(who) {
    var trigger = el(
      "button",
      { class: "me", type: "button", "aria-haspopup": "menu", "aria-expanded": "false", "aria-controls": "meMenu" },
      [avatar(who), el("span", { class: "me-name", text: who.name })],
    );
    var items = [];
    if (who.landlord) items.push(portalItem("Landlord portal", "l"));
    if (who.tenant) items.push(portalItem("Your home", "t"));
    if (!who.landlord && !who.tenant) items.push(portalItem("Open Keyring", "t"));
    var menu = el(
      "div",
      { class: "menu", id: "meMenu", role: "menu", hidden: "" },
      [
        el("div", { class: "menu__head" }, [
          avatar(who),
          el("div", {}, [
            el("p", { class: "menu__name", text: who.name }),
            who.email ? el("p", { class: "menu__sub", text: who.email }) : null,
            who.entitlement === "owner" ? el("p", { class: "menu__sub", text: "Project owner" }) : null,
          ]),
        ]),
      ]
        .concat(items)
        .concat([
          el("a", {
            class: "menu__item",
            role: "menuitem",
            href: "https://yard.sh/library/security",
            text: "Connected apps",
          }),
          el("a", { class: "menu__item menu__item--quiet", role: "menuitem", href: LOGOUT, text: "Log out" }),
        ]),
    );

    function setOpen(open) {
      menu.hidden = !open;
      trigger.setAttribute("aria-expanded", String(open));
    }
    trigger.addEventListener("click", function (e) {
      e.stopPropagation();
      setOpen(menu.hidden);
    });
    document.addEventListener("click", function (e) {
      if (!menu.hidden && !menu.contains(e.target)) setOpen(false);
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && !menu.hidden) {
        setOpen(false);
        trigger.focus();
      }
    });

    var open = el("a", { class: "btn btn--brass btn--sm" });
    var portal = who.landlord ? "l" : "t";
    open.textContent = who.landlord ? "Your properties" : who.tenant ? "Your home" : "Open Keyring";
    portalLink(open, portal);
    slot.replaceChildren(open, el("div", { class: "me-wrap" }, [trigger, menu]));

    // The rest of the page greets them too.
    [
      ["heroLandlord", "closerLandlord"],
      ["heroTenant", "closerTenant"],
    ].forEach(function (ids, i) {
      var isLandlord = i === 0;
      ids.forEach(function (id) {
        var link = document.getElementById(id);
        if (isLandlord && who.landlord) link.textContent = "Go to your properties";
        if (!isLandlord && who.tenant) link.textContent = "Go to your home";
      });
    });
    var foot = document.getElementById("footAuth");
    foot.textContent = "Log out";
    foot.href = LOGOUT;
    delete foot.dataset.portal;
  }

  function portalItem(text, portal) {
    var a = el("a", { class: "menu__item", role: "menuitem", text: text });
    portalLink(a, portal);
    return a;
  }

  whoIsHere().then(function (who) {
    if (who) renderSignedIn(who);
    else renderSignedOut();
  });

  /* ------------------------------------------------------------ pricing */

  // The Landlord card is built from the project's own tiers, so the page
  // never carries a tier id or a price of its own; the copy in the HTML is
  // the fallback when window.yard.project isn't there (a local preview
  // without project data). The Tenant card is not a tier: tenants just sign in.
  function money(cents) {
    var dollars = cents / 100;
    return "$" + (Number.isInteger(dollars) ? dollars : dollars.toFixed(2));
  }

  function fillPricing() {
    var project = window.yard && window.yard.project;
    var tiers = project && Array.isArray(project.tiers) ? project.tiers : null;
    if (!tiers || !tiers.length) return false;
    var tier =
      tiers.find(function (t) {
        return t.name === "Landlord";
      }) ||
      tiers.find(function (t) {
        return t.is_default;
      }) ||
      tiers[0];
    var card = document.getElementById("landlordPlan");
    var buy = document.getElementById("buyBtn");
    var subscription = tier.pricing_model === "subscription";
    card.querySelector("[data-name]").textContent = tier.name;
    card.querySelector("[data-amount]").textContent = money(tier.price_cents);
    card.querySelector("[data-per]").textContent = subscription ? "/ month" : "once";
    buy.textContent = "Subscribe for " + money(tier.price_cents) + (subscription ? " / month" : "");
    if (tier.description) card.querySelector("[data-blurb]").textContent = tier.description;
    if (tier.features && tier.features.length) {
      card.querySelector("[data-features]").replaceChildren.apply(
        card.querySelector("[data-features]"),
        tier.features.map(function (f) {
          return el("li", { text: f });
        }),
      );
    }

    if (tier.id) buy.dataset.tierId = tier.id;

    // Trials are per tier: the button only appears when this tier has one,
    // and it names this tier so the redirect starts the right trial.
    var trial = document.getElementById("trialBtn");
    if (tier.free_trial && tier.free_trial.enabled) {
      if (tier.id) trial.dataset.tierId = tier.id;
      trial.textContent =
        "Start a " +
        tier.free_trial.days +
        "-day free trial" +
        (tier.free_trial.requires_card ? "" : ", no card");
      trial.hidden = false;
    }

    ownership().then(function (state) {
      if (state && state.owned && (!state.tier_id || state.tier_id === tier.id)) {
        document.getElementById("planBadge").hidden = false;
      }
    });
    return true;
  }

  // embed.js may land after this script; give it a moment.
  var tries = 0;
  (function waitForYard() {
    if (fillPricing() || ++tries > 40) return;
    setTimeout(waitForYard, 100);
  })();

  /* -------------------------------------------------------------- theme */

  var themeBtn = document.getElementById("theme");
  function currentTheme() {
    return (
      document.documentElement.dataset.theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
    );
  }
  function paintTheme() {
    themeBtn.setAttribute("aria-label", currentTheme() === "dark" ? "Switch to light" : "Switch to dark");
  }
  themeBtn.addEventListener("click", function () {
    var next = currentTheme() === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("keyring.theme", next);
    } catch (err) {}
    paintTheme();
  });
  paintTheme();

  /* ---------------------------------------------------------------- nav */

  var nav = document.getElementById("nav");
  function onScroll() {
    nav.classList.toggle("stuck", window.scrollY > 40);
  }
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  /* ------------------------------------------------------------ keyring */

  // Five tags hang from points along the bottom of the ring. Each one is a
  // damped spring around its resting angle: moving the pointer across the
  // ring pushes the tags it passes, a push nudges the neighbours a little
  // (that's the jingle), and a click flips a tag to its pretend status. The
  // loop runs only while something moves, the ring is on screen and the tab
  // is visible; with reduced motion the tags hang still and flip in place.
  var ring = document.getElementById("ring");
  var tags = [].slice.call(ring.querySelectorAll(".ktag"));
  var reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

  var STIFFNESS = 60; // 1/s², pull back to rest
  var DAMPING = 2.6; // 1/s, how fast a swing dies
  var COUPLING = 0.012; // share of a tag's swing its neighbours feel
  var MAX_SPIN = 420; // deg/s
  var ARC = [150, 120, 90, 60, 30]; // where each tag hangs on the ring, in degrees

  var sim = tags.map(function (tag, i) {
    var rest = (ARC[i] - 90) * 0.42;
    return { angle: rest, spin: 0, rest: rest, x: 0, y: 0 };
  });

  tags.forEach(function (tag, i) {
    var front = tag.querySelector(".ktag__face--front");
    var back = tag.querySelector(".ktag__face--back");
    front.dataset.label = "Unit";
    front.appendChild(el("span", { class: "ktag__big", text: tag.dataset.front }));
    back.dataset.label = "Unit " + tag.dataset.front;
    back.appendChild(el("span", { class: "ktag__big", text: tag.dataset.back }));
    back.appendChild(el("span", { class: "ktag__note", text: tag.dataset.note }));
    tag.setAttribute("aria-label", "Unit " + tag.dataset.front + ": " + tag.dataset.back + ", " + tag.dataset.note);
    tag.style.setProperty("--a", sim[i].rest.toFixed(2) + "deg");
    tag.addEventListener("click", function () {
      var flipped = tag.getAttribute("aria-pressed") === "true";
      tag.setAttribute("aria-pressed", String(!flipped));
      push(i, flipped ? -140 : 140);
    });
  });

  // Put each tag's hole on the ring.
  function place() {
    var box = ring.getBoundingClientRect();
    var loop = ring.querySelector(".ring__loop").getBoundingClientRect();
    var r = (loop.width * 92) / 220;
    var cx = loop.left - box.left + loop.width / 2;
    var cy = loop.top - box.top + loop.height / 2;
    tags.forEach(function (tag, i) {
      var phi = (ARC[i] * Math.PI) / 180;
      sim[i].x = cx + r * Math.cos(phi);
      sim[i].y = cy + r * Math.sin(phi);
      tag.style.left = sim[i].x + "px";
      tag.style.top = sim[i].y - 9 + "px";
    });
  }
  place();
  window.addEventListener("resize", place);

  var visible = true;
  var frame = 0;
  var last = 0;

  function push(i, spin) {
    if (reduced) return;
    var s = sim[i];
    s.spin = Math.max(-MAX_SPIN, Math.min(MAX_SPIN, s.spin + spin));
    start();
  }

  function start() {
    if (frame || reduced || !visible || document.hidden) return;
    last = performance.now();
    frame = requestAnimationFrame(tick);
  }

  function tick(now) {
    var dt = Math.min(0.032, (now - last) / 1000);
    last = now;
    var moving = false;
    sim.forEach(function (s, i) {
      var pull = -STIFFNESS * (s.angle - s.rest) - DAMPING * s.spin;
      s.spin += pull * dt;
      if (i > 0) sim[i - 1].spin += s.spin * COUPLING;
      if (i < sim.length - 1) sim[i + 1].spin += s.spin * COUPLING;
      s.angle += s.spin * dt;
      if (Math.abs(s.spin) > 0.5 || Math.abs(s.angle - s.rest) > 0.1) moving = true;
      tags[i].style.setProperty("--a", s.angle.toFixed(2) + "deg");
    });
    frame = moving && visible && !document.hidden ? requestAnimationFrame(tick) : 0;
  }

  // A pointer sweeping across the tags pushes the ones it passes, in the
  // direction it moves. Rotating clockwise moves a tag's bottom left, so a
  // rightward sweep is a negative spin.
  var lastPointer = null;
  ring.addEventListener("pointermove", function (e) {
    var box = ring.getBoundingClientRect();
    var x = e.clientX - box.left;
    var y = e.clientY - box.top;
    var now = performance.now();
    if (lastPointer && now - lastPointer.t < 100) {
      var vx = (x - lastPointer.x) / Math.max(8, now - lastPointer.t);
      sim.forEach(function (s, i) {
        var near = Math.abs(x - s.x) < 46 && y > s.y && y < s.y + 150;
        if (near) push(i, -vx * 90);
      });
    }
    lastPointer = { x: x, y: y, t: now };
  });
  ring.addEventListener("pointerleave", function () {
    lastPointer = null;
  });

  // Now and then, a breeze.
  setInterval(function () {
    if (!visible || document.hidden) return;
    push(Math.floor(Math.random() * sim.length), (Math.random() - 0.5) * 60);
  }, 4200);

  if ("IntersectionObserver" in window) {
    new IntersectionObserver(function (entries) {
      visible = entries[0].isIntersecting;
      if (visible) start();
    }).observe(ring);
  }
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) start();
  });

  // A first jingle on arrival.
  if (!reduced) {
    setTimeout(function () {
      push(1, 90);
      push(3, -70);
    }, 500);
  }
})();
