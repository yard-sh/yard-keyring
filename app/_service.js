// Keyring backend.
//
// No ports, no listen(): Yard runs this as a fetch handler. Requests arrive
// with the app path rooted at "/" and, for signed-in visitors, trusted
// identity headers the edge verified:
//   X-Yard-User-Id, X-Yard-Email, X-Yard-Entitlement, X-Yard-Tier, X-Yard-Sandbox
// Clients can never spoof these: the edge strips inbound X-Yard-* first, and
// `yard dev` stamps the same headers locally from the persona you pick.
//
// Two things live in this file. The default export is the fetch handler:
// properties, units, leases, invites, the rent ledger and its simulated
// payments, announcements and maintenance requests, all in env.DB. The
// Property class is an object: one instance per property, declared under
// "objects" in .yard/settings.json and reached through env.PROPERTIES. It
// holds every open connection to that property, relays what happens there to
// the people it concerns, and buffers request comments until its alarm writes
// them to the database in one batch.
//
// Who is who: a property has exactly one landlord (whoever created it), and
// its tenants are the people on a running lease there. Both come from the
// database on every request. Landlord *writes* also need the Landlord plan,
// read from the edge's headers; reads never do, so a lapsed plan leaves a
// landlord read-only and never locks a tenant out.
//
// Requests are called tickets in here, because `request` is already the
// fetch argument. The app calls them requests.

const LANDLORD = "landlord";
const TENANT = "tenant";

// The one tier in .yard/settings.json. Renaming it there means renaming it
// here too.
const LANDLORD_TIER = "Landlord";

// Guardrails. The client reads these from api/me to explain refusals; the
// server is what enforces them.
const LIMITS = {
  properties: 25, // properties one landlord owns
  units: 300, // units in one property
  unitsPerCall: 100, // units added in one request
  tenants: 6, // people on one lease, unclaimed invites included
  leasesHere: 8, // running leases one person holds in one property
  openTickets: 20, // unresolved requests on one lease
  comments: 500, // comments on one request
  announcements: 200, // posts in one property
  charges: 200, // one-off charges on one lease
  payItems: 36, // items settled by one payment
  pending: 1000, // comments one object holds before its flush
  peers: 300, // connections to one property at once
};

const MAX = {
  name: 40,
  property: 80,
  address: 160,
  unit: 20,
  phone: 30,
  hours: 80,
  title: 120,
  label: 60,
  announcement: 4000,
  body: 2000,
  email: 254,
};

const MAX_CENTS = 10_000_000; // $100,000 for one rent or charge

const DAY_MS = 24 * 60 * 60 * 1000;
const INVITE_TTL_MS = 14 * DAY_MS;
const START_WINDOW_MONTHS = 12; // how far back or ahead a lease may start
const RENT_HISTORY_MONTHS = 120; // rent items one ledger computes, at most
const OVERDUE_AFTER_MS = DAY_MS; // unpaid past the end of its due day
const FLUSH_MS = 5000;
const FLUSH_ROWS = 100;
const FANOUT = 20; // object calls in flight at once

// Close codes the client understands. None of the first three reconnect;
// 4004 does, and learns what changed from the database on the way back in.
// 1000 "Session limit reached" is the platform's 24-hour cap.
const CLOSE_FULL = 4001;
const CLOSE_DELETED = 4002;
const CLOSE_REMOVED = 4003;
const CLOSE_CHANGED = 4004;

const CATEGORIES = ["plumbing", "electrical", "appliance", "heating", "pest", "other"];
const STATUSES = ["submitted", "acknowledged", "in_progress", "resolved"];
const CHARGE_KINDS = { deposit: "Security deposit", late_fee: "Late fee", utilities: "Utilities", other: "Charge" };
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

// The simulated card network. The browser maps a test card number to one of
// these and sends only the token: a card number never reaches this file.
const TEST_CARDS = {
  tok_visa: { ok: true, last4: "4242" },
  tok_chargeDeclined: { ok: false, last4: "0002" },
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH_RE = /^(\d{4})-(\d{2})$/;
const CODE_RE = /^KR-[A-Z2-9]{8}$/;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Never serve the backend as an asset. Yard excludes it server-side; this
    // guard keeps any other host honest.
    if (url.pathname === "/_service.js") {
      return new Response("Not found", { status: 404 });
    }

    if (url.pathname.startsWith("/api/")) {
      const started = Date.now();
      try {
        const response = await handleAPI(request, env, url);
        log("request", {
          method: request.method,
          path: redactPath(url.pathname),
          status: response.status,
          user: shortId(request.headers.get("X-Yard-User-Id")),
          ms: Date.now() - started,
        });
        return response;
      } catch (err) {
        console.error(`[keyring] request.failed ${request.method} ${redactPath(url.pathname)}`, err && err.stack);
        return fail(500, "server_error", "something went wrong on our end");
      }
    }

    // Everything else: the static frontend (env.ASSETS is this directory).
    return env.ASSETS.fetch(request);
  },
};

/* ------------------------------------------------------------------- api */

async function handleAPI(request, env, url) {
  // The access gate normally guarantees the header; this is the backstop.
  const user = request.headers.get("X-Yard-User-Id");
  const method = request.method;
  if (!user) {
    log("auth.rejected", { method, path: redactPath(url.pathname) });
    return fail(401, "signed_out", "sign in to use Keyring");
  }

  const me = await ensureUser(env, request.headers, user);
  const c = { request, env, me, user, method };

  // ["api", "leases", "<id>", "charges"]: the leading "api" is dropped.
  const [, ...seg] = url.pathname.split("/").filter(Boolean);
  const [head, id, sub, subId] = seg;
  const n = seg.length;

  if (head === "me" && n === 1) {
    if (method === "GET") return getMe(c);
    if (method === "PATCH") return renameMe(c);
    return methodNotAllowed();
  }

  if (head === "properties" && n === 1) {
    if (method === "GET") return listProperties(c);
    if (method === "POST") return createProperty(c);
    return methodNotAllowed();
  }

  if (head === "properties") {
    const access = await propertyAccess(env, user, id);
    if (!access) return notFound("property not found");
    if (n === 2) {
      if (method === "GET") return propertyDetail(c, access);
      if (method === "PATCH") return updateProperty(c, access);
      if (method === "DELETE") return deleteProperty(c, access);
      return methodNotAllowed();
    }
    if (sub === "rentroll" && n === 3 && method === "GET") return rentRoll(c, access);
    if (sub === "units" && n === 3 && method === "POST") return addUnits(c, access);
    if (sub === "announcements" && n === 3) {
      if (method === "GET") return listAnnouncements(c, access);
      if (method === "POST") return postAnnouncement(c, access);
      return methodNotAllowed();
    }
    if (sub === "announcements" && n === 4) {
      if (method === "PATCH") return updateAnnouncement(c, access, subId);
      if (method === "DELETE") return deleteAnnouncement(c, access, subId);
      return methodNotAllowed();
    }
    if (sub === "tickets" && n === 3 && method === "GET") return listTickets(c, access, url.searchParams);
    if (sub === "ws" && n === 3 && method === "GET") return connectProperty(c, access);
    return notFound();
  }

  if (head === "units" && n >= 2) {
    const access = await unitAccess(env, user, id);
    if (!access) return notFound("unit not found");
    if (n === 2) {
      if (method === "GET") return unitDetail(c, access);
      if (method === "PATCH") return renameUnit(c, access);
      if (method === "DELETE") return deleteUnit(c, access);
      return methodNotAllowed();
    }
    if (sub === "leases" && n === 3 && method === "POST") return startLease(c, access);
    return notFound();
  }

  if (head === "leases" && n >= 2) {
    const access = await leaseAccess(env, user, id);
    if (!access) return notFound("lease not found");
    if (n === 2) {
      if (method === "GET") return leaseDetail(c, access);
      if (method === "PATCH") return updateLease(c, access);
      return methodNotAllowed();
    }
    if (sub === "end" && n === 3 && method === "POST") return endLease(c, access);
    if (sub === "tenants" && n === 4 && method === "DELETE") return removeTenant(c, access, subId);
    if (sub === "invites" && n === 3 && method === "POST") return createInvite(c, access);
    if (sub === "invites" && n === 4 && method === "DELETE") return revokeInvite(c, access, subId);
    if (sub === "charges" && n === 3 && method === "POST") return addCharge(c, access);
    if (sub === "charges" && n === 4 && method === "DELETE") return voidCharge(c, access, subId);
    if (sub === "payments" && n === 3 && method === "POST") return pay(c, access);
    if (sub === "receipts" && n === 4 && method === "GET") return receipt(c, access, subId);
    if (sub === "tickets" && n === 3 && method === "POST") return createTicket(c, access);
    return notFound();
  }

  if (head === "invites" && (n === 2 || n === 3)) {
    if (n === 2 && method === "GET") return previewInvite(c, id);
    if (n === 3 && sub === "claim" && method === "POST") return claimInvite(c, id);
    return methodNotAllowed();
  }

  if (head === "tickets" && n >= 2) {
    const access = await ticketAccess(env, user, id);
    if (!access) return notFound("request not found");
    if (n === 2) {
      if (method === "GET") return ticketDetail(c, access);
      if (method === "PATCH") return updateTicket(c, access);
      if (method === "DELETE") return withdrawTicket(c, access);
      return methodNotAllowed();
    }
    if (sub === "comments" && n === 3 && method === "POST") return postComment(c, access);
    return notFound();
  }

  return notFound();
}

/* -------------------------------------------------------------- identity */

// Landlord powers are the project owner (a seller never buys their own
// project), or a live subscription or trial of the Landlord tier. The Yard
// docs say X-Yard-Tier is absent on single-price projects, and Keyring has a
// single tier, so a missing tier counts; a tier that is present must be ours,
// so a tier added later never unlocks landlord powers by accident.
function landlordPlan(headers) {
  const entitlement = headers.get("X-Yard-Entitlement") || "none";
  if (entitlement === "owner") return true;
  if (entitlement !== "active" && entitlement !== "trial") return false;
  const tier = headers.get("X-Yard-Tier");
  return !tier || tier === LANDLORD_TIER;
}

// There is no display-name header, so the first visit derives one from the
// email and the app lets people change it. ON CONFLICT leaves name alone, so
// a rename survives every later request.
async function ensureUser(env, headers, user) {
  const email = headers.get("X-Yard-Email") || "";
  const entitlement = headers.get("X-Yard-Entitlement") || "none";
  const row = await env.DB.prepare(
    "INSERT INTO users (id, name, email, seen_at) VALUES (?1, ?2, ?3, ?4)" +
      " ON CONFLICT(id) DO UPDATE SET email = excluded.email, seen_at = excluded.seen_at" +
      " RETURNING name",
  )
    .bind(user, defaultName(user, email), email, Date.now())
    .first();
  return {
    user_id: user,
    name: row.name,
    email,
    entitlement,
    trial: entitlement === "trial",
    landlord_plan: landlordPlan(headers),
  };
}

function defaultName(user, email) {
  const local = (email.split("@")[0] || "").replace(/[^A-Za-z0-9._-]/g, "").slice(0, MAX.name);
  return local || "user-" + shortId(user);
}

// Everything the app needs to pick a portal: the properties this person
// runs and the leases they live under.
async function getMe(c) {
  const { env, user } = c;
  const [properties, leases] = await Promise.all([
    env.DB.prepare("SELECT id, name FROM properties WHERE landlord_id = ?1 ORDER BY created_at").bind(user).all(),
    env.DB.prepare(
      "SELECT l.id, l.property_id, p.name AS property_name, un.number AS unit_number" +
        " FROM lease_tenants t JOIN leases l ON l.id = t.lease_id" +
        " JOIN properties p ON p.id = l.property_id JOIN units un ON un.id = l.unit_id" +
        " WHERE t.user_id = ?1 AND l.ended_at IS NULL ORDER BY t.joined_at",
    )
      .bind(user)
      .all(),
  ]);
  return json({ ...c.me, limits: LIMITS, properties: properties.results, leases: leases.results });
}

async function renameMe(c) {
  const { name } = await readJSON(c.request);
  const clean = oneLine(name, MAX.name);
  if (!clean) return fail(400, "name_required", "pick a name");
  await c.env.DB.prepare("UPDATE users SET name = ?1 WHERE id = ?2").bind(clean, c.user).run();
  log("me.rename", { user: shortId(c.user), nameLen: clean.length });
  return json({ ...c.me, name: clean });
}

/* ---------------------------------------------------------------- access */

// The database is the only authority. Anything you are not part of answers
// 404, the same as something that doesn't exist, so ids can't be probed.
//
// A landlord is properties.landlord_id. A tenant is someone on a running
// lease there (ended_at IS NULL); ending a lease or removing a tenant takes
// their access with it.
async function propertyAccess(env, user, propertyId) {
  if (!isId(propertyId)) return null;
  const row = await env.DB.prepare(
    "SELECT p.*, (SELECT group_concat(t.lease_id) FROM lease_tenants t JOIN leases l ON l.id = t.lease_id" +
      " WHERE t.property_id = p.id AND t.user_id = ?2 AND l.ended_at IS NULL) AS my_leases" +
      " FROM properties p WHERE p.id = ?1",
  )
    .bind(propertyId, user)
    .first();
  if (!row) return null;
  const { my_leases: mine, ...property } = row;
  if (property.landlord_id === user) return { property, role: LANDLORD, leases: [], user };
  const leases = mine ? String(mine).split(",").slice(0, LIMITS.leasesHere) : [];
  if (!leases.length) return null;
  return { property, role: TENANT, leases, user };
}

// Units are the landlord's business only; a tenant sees their unit through
// their lease.
async function unitAccess(env, user, unitId) {
  if (!isId(unitId)) return null;
  const row = await env.DB.prepare(
    "SELECT un.id, un.property_id, un.number, un.created_at, p.landlord_id, p.name AS property_name" +
      " FROM units un JOIN properties p ON p.id = un.property_id WHERE un.id = ?1",
  )
    .bind(unitId)
    .first();
  if (!row || row.landlord_id !== user) return null;
  return { unit: row, role: LANDLORD, user };
}

async function leaseAccess(env, user, leaseId) {
  if (!isId(leaseId)) return null;
  const row = await env.DB.prepare(
    "SELECT l.id, l.property_id, l.unit_id, l.due_day, l.starts_at, l.ends_at, l.ended_at, l.created_at," +
      " un.number AS unit_number, p.landlord_id, p.name AS property_name, p.address, p.phone, p.emergency, p.hours," +
      " EXISTS (SELECT 1 FROM lease_tenants t WHERE t.lease_id = l.id AND t.user_id = ?2) AS is_tenant" +
      " FROM leases l JOIN units un ON un.id = l.unit_id JOIN properties p ON p.id = l.property_id" +
      " WHERE l.id = ?1",
  )
    .bind(leaseId, user)
    .first();
  if (!row) return null;
  if (row.landlord_id === user) return { lease: row, role: LANDLORD, user };
  if (row.is_tenant && row.ended_at === null) return { lease: row, role: TENANT, user };
  return null;
}

async function ticketAccess(env, user, ticketId) {
  if (!isId(ticketId)) return null;
  const row = await env.DB.prepare(
    "SELECT k.*, p.landlord_id, l.ended_at, un.number AS unit_number, cu.name AS created_by_name," +
      " EXISTS (SELECT 1 FROM lease_tenants t WHERE t.lease_id = k.lease_id AND t.user_id = ?2) AS is_tenant" +
      " FROM tickets k JOIN properties p ON p.id = k.property_id JOIN leases l ON l.id = k.lease_id" +
      " JOIN units un ON un.id = l.unit_id LEFT JOIN users cu ON cu.id = k.created_by WHERE k.id = ?1",
  )
    .bind(ticketId, user)
    .first();
  if (!row) return null;
  if (row.landlord_id === user) return { ticket: row, role: LANDLORD, user };
  if (row.is_tenant && row.ended_at === null) return { ticket: row, role: TENANT, user };
  return null;
}

// A landlord write: the thing must be theirs (from the database) and their
// plan live (from the edge). A tenant gets landlord_only; a landlord whose
// trial or subscription ended gets plan_required and stays read-only.
function manage(c, access) {
  if (access.role !== LANDLORD) return landlordOnly();
  if (!c.me.landlord_plan) return planRequired(c);
  return null;
}

function landlordOnly() {
  return fail(403, "landlord_only", "only the landlord can do that");
}

function planRequired(c) {
  log("plan.required", { user: shortId(c.user), entitlement: c.me.entitlement });
  return fail(403, "plan_required", "managing properties needs the Landlord plan");
}

/* ------------------------------------------------------------ properties */

async function listProperties(c) {
  const { results } = await c.env.DB.prepare(
    "SELECT p.id, p.name, p.address, p.created_at," +
      " (SELECT COUNT(*) FROM units un WHERE un.property_id = p.id) AS units," +
      " (SELECT COUNT(*) FROM leases l WHERE l.property_id = p.id AND l.ended_at IS NULL) AS occupied," +
      " (SELECT COUNT(*) FROM tickets k WHERE k.property_id = p.id AND k.status != 'resolved') AS open_tickets" +
      " FROM properties p WHERE p.landlord_id = ?1 ORDER BY p.created_at",
  )
    .bind(c.user)
    .all();
  return json(results);
}

function propertyFields(body, current) {
  const next = { ...current };
  if (body.name !== undefined) next.name = oneLine(body.name, MAX.property);
  if (body.address !== undefined) next.address = oneLine(body.address, MAX.address);
  if (body.phone !== undefined) next.phone = oneLine(body.phone, MAX.phone);
  if (body.emergency !== undefined) next.emergency = oneLine(body.emergency, MAX.phone);
  if (body.hours !== undefined) next.hours = oneLine(body.hours, MAX.hours);
  return next;
}

async function createProperty(c) {
  const { env, user } = c;
  if (!c.me.landlord_plan) return planRequired(c);
  const fields = propertyFields(await readJSON(c.request), {
    name: "",
    address: "",
    phone: "",
    emergency: "",
    hours: "",
  });
  if (!fields.name) return fail(400, "name_required", "give the property a name");

  const owned = await env.DB.prepare("SELECT COUNT(*) AS n FROM properties WHERE landlord_id = ?1").bind(user).first();
  if (owned.n >= LIMITS.properties) {
    return fail(403, "property_limit", `a landlord can run up to ${LIMITS.properties} properties`);
  }

  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO properties (id, landlord_id, name, address, phone, emergency, hours, created_at)" +
      " VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
  )
    .bind(id, user, fields.name, fields.address, fields.phone, fields.emergency, fields.hours, Date.now())
    .run();
  log("property.create", { property: shortId(id), user: shortId(user) });
  return propertyDetail(c, await propertyAccess(env, user, id), 201);
}

async function propertyDetail(c, access, status = 200) {
  const { property, role } = access;
  const landlord = await c.env.DB.prepare("SELECT name FROM users WHERE id = ?1").bind(property.landlord_id).first();
  return json(
    {
      id: property.id,
      name: property.name,
      address: property.address,
      phone: property.phone,
      emergency: property.emergency,
      hours: property.hours,
      created_at: property.created_at,
      landlord_name: (landlord && landlord.name) || "Your landlord",
      role,
      can_write: role === LANDLORD && c.me.landlord_plan,
      leases: access.leases,
    },
    status,
  );
}

async function updateProperty(c, access) {
  const denied = manage(c, access);
  if (denied) return denied;
  const fields = propertyFields(await readJSON(c.request), access.property);
  if (!fields.name) return fail(400, "name_required", "give the property a name");
  await c.env.DB.prepare(
    "UPDATE properties SET name = ?1, address = ?2, phone = ?3, emergency = ?4, hours = ?5 WHERE id = ?6",
  )
    .bind(fields.name, fields.address, fields.phone, fields.emergency, fields.hours, access.property.id)
    .run();
  await notify(c.env, access.property.id, { t: "property.changed" }, "all");
  log("property.update", { property: shortId(access.property.id) });
  return propertyDetail(c, { ...access, property: { ...access.property, ...fields } });
}

// The rows go first, so nobody can reconnect while the object is being
// cleared; then the object closes every socket and drops its storage. The
// typed name is checked here too, so a stray API call can't do what the
// dialog makes deliberate.
async function deleteProperty(c, access) {
  const denied = manage(c, access);
  if (denied) return denied;
  const { property } = access;
  const body = await readJSON(c.request);
  if (oneLine(body.confirm_name, MAX.property).toLowerCase() !== property.name.toLowerCase()) {
    return fail(400, "confirm_mismatch", "type the property's name to delete it");
  }
  const tables = [
    "ticket_events",
    "tickets",
    "announcements",
    "payments",
    "charges",
    "invites",
    "lease_tenants",
    "rent_steps",
    "leases",
    "units",
  ];
  await c.env.DB.batch([
    ...tables.map((t) => c.env.DB.prepare(`DELETE FROM ${t} WHERE property_id = ?1`).bind(property.id)),
    c.env.DB.prepare("DELETE FROM properties WHERE id = ?1").bind(property.id),
  ]);
  await internal(c.env, property.id, "/__delete");
  log("property.delete", { property: shortId(property.id) });
  return json({ ok: true });
}

/* ------------------------------------------------------------- rent roll */

// One row per unit, with its running lease's balance, plus the numbers a
// landlord looks at first. Every lease's ledger is computed from five reads
// of the whole property, never one query per unit.
async function rentRoll(c, access) {
  if (access.role !== LANDLORD) return landlordOnly();
  const { env } = c;
  const pid = access.property.id;
  const now = Date.now();
  const running = "SELECT id FROM leases WHERE property_id = ?1 AND ended_at IS NULL";
  const [units, steps, charges, payments, tenants, invites, collected, tickets] = await Promise.all([
    env.DB.prepare(
      "SELECT un.id, un.number, l.id AS lease_id, l.due_day, l.starts_at, l.ends_at, l.ended_at" +
        " FROM units un LEFT JOIN leases l ON l.unit_id = un.id AND l.ended_at IS NULL WHERE un.property_id = ?1",
    )
      .bind(pid)
      .all(),
    env.DB.prepare(
      `SELECT lease_id, from_month, rent_cents FROM rent_steps WHERE lease_id IN (${running}) ORDER BY from_month`,
    )
      .bind(pid)
      .all(),
    env.DB.prepare(`SELECT id, lease_id, kind, label, amount_cents, due_at FROM charges WHERE lease_id IN (${running})`)
      .bind(pid)
      .all(),
    env.DB.prepare(
      `SELECT lease_id, item_ref, label, amount_cents, paid_at FROM payments WHERE lease_id IN (${running})`,
    )
      .bind(pid)
      .all(),
    env.DB.prepare(
      `SELECT t.lease_id, u.name FROM lease_tenants t JOIN users u ON u.id = t.user_id WHERE t.lease_id IN (${running}) ORDER BY t.joined_at`,
    )
      .bind(pid)
      .all(),
    env.DB.prepare(
      `SELECT lease_id, COUNT(*) AS n FROM invites WHERE lease_id IN (${running}) AND claimed_by IS NULL AND expires_at > ?2 GROUP BY lease_id`,
    )
      .bind(pid, now)
      .all(),
    env.DB.prepare(
      "SELECT COALESCE(SUM(amount_cents), 0) AS cents FROM payments WHERE property_id = ?1 AND paid_at >= ?2",
    )
      .bind(pid, monthStart(now))
      .first(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM tickets WHERE property_id = ?1 AND status != 'resolved'")
      .bind(pid)
      .first(),
  ]);

  const byLease = (rows) => {
    const map = new Map();
    for (const row of rows) {
      if (!map.has(row.lease_id)) map.set(row.lease_id, []);
      map.get(row.lease_id).push(row);
    }
    return map;
  };
  const stepsOf = byLease(steps.results);
  const chargesOf = byLease(charges.results);
  const paymentsOf = byLease(payments.results);
  const tenantsOf = byLease(tenants.results);
  const invitesOf = new Map(invites.results.map((r) => [r.lease_id, r.n]));

  let outstanding = 0;
  let overdueLeases = 0;
  let occupied = 0;
  const rows = units.results.map((u) => {
    if (!u.lease_id) return { unit_id: u.id, number: u.number, lease: null };
    occupied += 1;
    const lease = {
      id: u.lease_id,
      due_day: u.due_day,
      starts_at: u.starts_at,
      ends_at: u.ends_at,
      ended_at: u.ended_at,
    };
    const ledger = ledgerOf(
      lease,
      stepsOf.get(u.lease_id) || [],
      chargesOf.get(u.lease_id) || [],
      paymentsOf.get(u.lease_id) || [],
      now,
    );
    outstanding += ledger.balance_cents;
    if (ledger.overdue_cents > 0) overdueLeases += 1;
    return {
      unit_id: u.id,
      number: u.number,
      lease: {
        id: u.lease_id,
        tenants: (tenantsOf.get(u.lease_id) || []).map((t) => t.name),
        pending_invites: invitesOf.get(u.lease_id) || 0,
        rent_cents: ledger.rent_cents,
        balance_cents: ledger.balance_cents,
        overdue_cents: ledger.overdue_cents,
        next_due: ledger.next_due,
        starts_at: u.starts_at,
        ends_at: u.ends_at,
        term_over: u.ends_at !== null && u.ends_at < dayStart(now),
      },
    };
  });
  rows.sort((a, b) => a.number.localeCompare(b.number, "en", { numeric: true, sensitivity: "base" }));

  return json({
    as_of: now,
    can_write: c.me.landlord_plan,
    stats: {
      units: rows.length,
      occupied,
      collected_month_cents: collected.cents,
      outstanding_cents: outstanding,
      overdue_leases: overdueLeases,
      open_tickets: tickets.n,
    },
    units: rows,
  });
}

/* ----------------------------------------------------------------- units */

// The client expands "101-110, PH" into a list; this only cleans, dedupes and
// counts. INSERT OR IGNORE lets a number that already exists pass quietly.
async function addUnits(c, access) {
  const denied = manage(c, access);
  if (denied) return denied;
  const { env } = c;
  const body = await readJSON(c.request);
  const seen = new Set();
  const numbers = [];
  for (const raw of Array.isArray(body.numbers) ? body.numbers : []) {
    const clean = oneLine(raw, MAX.unit);
    if (!clean || seen.has(clean.toLowerCase())) continue;
    seen.add(clean.toLowerCase());
    numbers.push(clean);
  }
  if (!numbers.length) return fail(400, "numbers_required", "list at least one unit number");
  if (numbers.length > LIMITS.unitsPerCall) {
    return fail(400, "too_many", `add up to ${LIMITS.unitsPerCall} units at a time`);
  }
  const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM units WHERE property_id = ?1")
    .bind(access.property.id)
    .first();
  if (count.n + numbers.length > LIMITS.units) {
    return fail(403, "unit_limit", `a property holds up to ${LIMITS.units} units`);
  }
  const now = Date.now();
  const results = await env.DB.batch(
    numbers.map((number) =>
      env.DB.prepare("INSERT OR IGNORE INTO units (id, property_id, number, created_at) VALUES (?1, ?2, ?3, ?4)").bind(
        crypto.randomUUID(),
        access.property.id,
        number,
        now,
      ),
    ),
  );
  const created = results.reduce((sum, r) => sum + changed(r), 0);
  log("unit.create", { property: shortId(access.property.id), created, skipped: numbers.length - created });
  return json({ created, skipped: numbers.length - created }, 201);
}

async function unitDetail(c, access) {
  const { env } = c;
  const { unit } = access;
  const [leases, tenants] = await Promise.all([
    env.DB.prepare(
      "SELECT l.id, l.due_day, l.starts_at, l.ends_at, l.ended_at, l.created_at," +
        " (SELECT rent_cents FROM rent_steps r WHERE r.lease_id = l.id ORDER BY r.from_month DESC LIMIT 1) AS rent_cents" +
        " FROM leases l WHERE l.unit_id = ?1 ORDER BY l.created_at DESC",
    )
      .bind(unit.id)
      .all(),
    env.DB.prepare(
      "SELECT t.lease_id, u.name FROM lease_tenants t JOIN users u ON u.id = t.user_id" +
        " WHERE t.lease_id IN (SELECT id FROM leases WHERE unit_id = ?1) ORDER BY t.joined_at",
    )
      .bind(unit.id)
      .all(),
  ]);
  const names = new Map();
  for (const t of tenants.results) {
    if (!names.has(t.lease_id)) names.set(t.lease_id, []);
    names.get(t.lease_id).push(t.name);
  }
  const running = leases.results.find((l) => l.ended_at === null);
  return json({
    unit: { id: unit.id, number: unit.number, property_id: unit.property_id, property_name: unit.property_name },
    can_write: c.me.landlord_plan,
    running_lease_id: running ? running.id : null,
    leases: leases.results.map((l) => ({ ...l, tenants: names.get(l.id) || [] })),
  });
}

async function renameUnit(c, access) {
  const denied = manage(c, access);
  if (denied) return denied;
  const number = oneLine((await readJSON(c.request)).number, MAX.unit);
  if (!number) return fail(400, "number_required", "give the unit a number");
  try {
    await c.env.DB.prepare("UPDATE units SET number = ?1 WHERE id = ?2").bind(number, access.unit.id).run();
  } catch (err) {
    // The unique index on (property_id, number) is the check.
    if (/UNIQUE/i.test(String(err && err.message))) return fail(409, "unit_exists", "that unit number is taken");
    throw err;
  }
  log("unit.rename", { unit: shortId(access.unit.id) });
  return json({ id: access.unit.id, number });
}

// Only a vacant unit can go, and its past leases go with it. Every history
// statement is limited to ended leases, and the unit itself is deleted only
// while it has no running lease, so a lease started a moment ago survives a
// race with this delete untouched.
async function deleteUnit(c, access) {
  const denied = manage(c, access);
  if (denied) return denied;
  const { env } = c;
  const { unit } = access;
  const ended = "SELECT id FROM leases WHERE unit_id = ?1 AND ended_at IS NOT NULL";
  const results = await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM ticket_events WHERE ticket_id IN (SELECT id FROM tickets WHERE lease_id IN (${ended}))`,
    ).bind(unit.id),
    ...["tickets", "payments", "charges", "invites", "lease_tenants", "rent_steps"].map((t) =>
      env.DB.prepare(`DELETE FROM ${t} WHERE lease_id IN (${ended})`).bind(unit.id),
    ),
    env.DB.prepare("DELETE FROM leases WHERE unit_id = ?1 AND ended_at IS NOT NULL").bind(unit.id),
    env.DB.prepare(
      "DELETE FROM units WHERE id = ?1 AND NOT EXISTS (SELECT 1 FROM leases WHERE unit_id = ?1 AND ended_at IS NULL)",
    ).bind(unit.id),
  ]);
  if (!changed(results[results.length - 1])) {
    return fail(409, "unit_occupied", "end the running lease before deleting this unit");
  }
  log("unit.delete", { unit: shortId(unit.id) });
  return json({ ok: true });
}

/* ---------------------------------------------------------------- leases */

// A lease comes first and its tenants follow by invite, so everything a
// tenant will see (terms, charges, requests) is scoped to one lease id from
// the start, and a new lease on the same unit starts with a clean ledger.
async function startLease(c, access) {
  const denied = manage(c, access);
  if (denied) return denied;
  const { env } = c;
  const { unit } = access;
  const body = await readJSON(c.request);
  const now = Date.now();

  const rent = cents(body.rent_cents);
  if (rent === null) return fail(400, "bad_rent", "rent must be between $0 and $100,000");
  const dueDay = Number(body.due_day);
  if (!Number.isInteger(dueDay) || dueDay < 1 || dueDay > 28) {
    return fail(400, "bad_due_day", "rent is due on a day from 1 to 28");
  }
  const startsAt = dateOn(body.starts_on);
  if (startsAt === null) return fail(400, "bad_start", "pick a start date");
  const today = monthOf(now);
  if (Math.abs(monthOf(startsAt) - today) > START_WINDOW_MONTHS) {
    return fail(400, "bad_start", `a lease starts within ${START_WINDOW_MONTHS} months of today`);
  }
  let endsAt = null;
  if (body.ends_on) {
    endsAt = dateOn(body.ends_on);
    if (endsAt === null || endsAt < startsAt) return fail(400, "bad_end", "the lease must end after it starts");
  }
  const emails = [];
  for (const raw of Array.isArray(body.emails) ? body.emails : []) {
    if (typeof raw === "string" && !raw.trim()) continue;
    const email = emailOf(raw);
    if (!email) return fail(400, "bad_email", "one of the email addresses doesn't look right");
    if (!emails.includes(email)) emails.push(email);
  }
  if (emails.length > LIMITS.tenants) return fail(400, "tenant_limit", `a lease has up to ${LIMITS.tenants} tenants`);

  const lease = { id: crypto.randomUUID(), due_day: dueDay, starts_at: startsAt };
  let results;
  try {
    results = await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO leases (id, property_id, unit_id, due_day, starts_at, ends_at, ended_at, created_at)" +
          " SELECT ?1, ?2, ?3, ?4, ?5, ?6, NULL, ?7" +
          " WHERE NOT EXISTS (SELECT 1 FROM leases WHERE unit_id = ?3 AND ended_at IS NULL)",
      ).bind(lease.id, unit.property_id, unit.id, dueDay, startsAt, endsAt, now),
      env.DB.prepare(
        "INSERT INTO rent_steps (lease_id, from_month, rent_cents, property_id)" +
          " SELECT ?1, ?2, ?3, ?4 WHERE EXISTS (SELECT 1 FROM leases WHERE id = ?1)",
      ).bind(lease.id, firstRentMonth(lease), rent, unit.property_id),
    ]);
  } catch (err) {
    // The partial unique index on leases(unit_id) is the backstop.
    if (/UNIQUE/i.test(String(err && err.message))) return fail(409, "unit_occupied", "this unit already has a lease");
    throw err;
  }
  if (!changed(results[0])) return fail(409, "unit_occupied", "this unit already has a lease");

  const invites = await insertInvites(env, { id: lease.id, property_id: unit.property_id }, emails, now);
  log("lease.create", { unit: shortId(unit.id), lease: shortId(lease.id), invites: invites.length });
  return json({ lease_id: lease.id, invites }, 201);
}

// The ledger view both portals read: terms, people, the landlord's contact
// card, and every item with its status as of now.
async function leaseDetail(c, access) {
  const { env } = c;
  const { lease, role } = access;
  const landlord = role === LANDLORD;
  const now = Date.now();
  const [ledger, tenants, invites, landlordRow] = await Promise.all([
    loadLedger(env, lease, now),
    env.DB.prepare(
      "SELECT t.user_id, u.name, u.email, t.joined_at FROM lease_tenants t JOIN users u ON u.id = t.user_id" +
        " WHERE t.lease_id = ?1 ORDER BY t.joined_at",
    )
      .bind(lease.id)
      .all(),
    landlord
      ? env.DB.prepare(
          "SELECT id, token, email, created_at, expires_at FROM invites WHERE lease_id = ?1 AND claimed_by IS NULL ORDER BY created_at",
        )
          .bind(lease.id)
          .all()
      : { results: [] },
    env.DB.prepare("SELECT name FROM users WHERE id = ?1").bind(lease.landlord_id).first(),
  ]);
  return json({
    as_of: now,
    role,
    can_write: landlord && c.me.landlord_plan,
    lease: {
      id: lease.id,
      unit_id: lease.unit_id,
      unit_number: lease.unit_number,
      due_day: lease.due_day,
      starts_at: lease.starts_at,
      ends_at: lease.ends_at,
      ended_at: lease.ended_at,
      rent_steps: ledger.steps.map((s) => ({ month: monthKey(s.from_month), rent_cents: s.rent_cents })),
    },
    property: {
      id: lease.property_id,
      name: lease.property_name,
      address: lease.address,
      phone: lease.phone,
      emergency: lease.emergency,
      hours: lease.hours,
      landlord_name: (landlordRow && landlordRow.name) || "Your landlord",
    },
    // Emails are the landlord's to see: roommates see names.
    tenants: tenants.results.map((t) => ({
      user_id: t.user_id,
      name: t.name,
      email: landlord ? t.email : undefined,
      joined_at: t.joined_at,
      is_you: t.user_id === c.user,
    })),
    invites: invites.results.map((i) => ({ ...i, expired: i.expires_at <= now })),
    items: ledger.items,
    rent_cents: ledger.rent_cents,
    balance_cents: ledger.balance_cents,
    overdue_cents: ledger.overdue_cents,
    next_due: ledger.next_due,
    next_rent: ledger.next_rent,
  });
}

// Rent changes and the scheduled end date. A new rent applies from a future
// month on (and replaces any change scheduled after it), so an item a tenant
// has already seen never changes its amount underneath them.
async function updateLease(c, access) {
  const denied = manage(c, access);
  if (denied) return denied;
  const { env } = c;
  const { lease } = access;
  if (lease.ended_at !== null) return fail(409, "lease_ended", "this lease has ended");
  const body = await readJSON(c.request);
  const now = Date.now();
  const statements = [];

  if (body.rent_cents !== undefined) {
    const rent = cents(body.rent_cents);
    if (rent === null) return fail(400, "bad_rent", "rent must be between $0 and $100,000");
    const from = body.from_month === undefined ? monthOf(now) + 1 : parseMonthKey(body.from_month);
    if (from === null || from <= monthOf(now)) {
      return fail(400, "bad_month", "a rent change starts in a future month");
    }
    statements.push(
      env.DB.prepare("DELETE FROM rent_steps WHERE lease_id = ?1 AND from_month > ?2").bind(lease.id, from),
      env.DB.prepare(
        "INSERT OR REPLACE INTO rent_steps (lease_id, from_month, rent_cents, property_id) VALUES (?1, ?2, ?3, ?4)",
      ).bind(lease.id, from, rent, lease.property_id),
    );
  }

  if (body.ends_on !== undefined) {
    let endsAt = null;
    if (body.ends_on) {
      endsAt = dateOn(body.ends_on);
      if (endsAt === null || endsAt < lease.starts_at)
        return fail(400, "bad_end", "the lease must end after it starts");
    }
    statements.push(env.DB.prepare("UPDATE leases SET ends_at = ?1 WHERE id = ?2").bind(endsAt, lease.id));
  }

  if (!statements.length) return fail(400, "nothing_to_change", "nothing to change");
  await env.DB.batch(statements);
  await notify(env, lease.property_id, { t: "lease.changed", lease_id: lease.id }, [lease.id]);
  log("lease.update", {
    lease: shortId(lease.id),
    rent: body.rent_cents !== undefined,
    term: body.ends_on !== undefined,
  });
  return leaseDetail(c, await leaseAccess(env, c.user, lease.id));
}

// Move-out. The last day caps rent; ended_at frees the unit and takes every
// tenant's access with it, starting with their open sockets. Unused invite
// links die with the lease.
async function endLease(c, access) {
  const denied = manage(c, access);
  if (denied) return denied;
  const { env } = c;
  const { lease } = access;
  if (lease.ended_at !== null) return fail(409, "lease_ended", "this lease has already ended");
  const body = await readJSON(c.request);
  const now = Date.now();
  const lastDay = body.last_day ? dateOn(body.last_day) : dayStart(now);
  if (lastDay === null || lastDay > dayStart(now)) {
    return fail(400, "bad_end", "the last day is today or earlier; schedule a later end on the lease instead");
  }
  const { results: tenants } = await env.DB.prepare("SELECT user_id FROM lease_tenants WHERE lease_id = ?1")
    .bind(lease.id)
    .all();
  const [ended] = await env.DB.batch([
    env.DB.prepare("UPDATE leases SET ends_at = ?1, ended_at = ?2 WHERE id = ?3 AND ended_at IS NULL").bind(
      lastDay,
      now,
      lease.id,
    ),
    env.DB.prepare("DELETE FROM invites WHERE lease_id = ?1 AND claimed_by IS NULL").bind(lease.id),
  ]);
  if (!changed(ended)) return fail(409, "lease_ended", "this lease has already ended");
  const kicked = await kickUsers(
    env,
    lease.property_id,
    tenants.map((t) => t.user_id),
  );
  log("lease.end", { lease: shortId(lease.id), tenants: tenants.length, kicked });
  return json({ ok: true, kicked });
}

async function removeTenant(c, access, target) {
  const denied = manage(c, access);
  if (denied) return denied;
  const { env } = c;
  const { lease } = access;
  const result = await env.DB.prepare("DELETE FROM lease_tenants WHERE lease_id = ?1 AND user_id = ?2")
    .bind(lease.id, String(target || ""))
    .run();
  if (!changed(result)) return notFound("not a tenant on this lease");
  const kicked = await kickUsers(env, lease.property_id, [target]);
  await notify(env, lease.property_id, { t: "lease.changed", lease_id: lease.id }, [lease.id]);
  log("tenant.remove", { lease: shortId(lease.id), user: shortId(target), kicked });
  return json({ ok: true, kicked });
}

/* --------------------------------------------------------------- invites */

// Links are single-use and last 14 days. The cap counts unclaimed links too,
// so every link a landlord has handed out can still succeed.
async function insertInvites(env, lease, emails, now) {
  if (!emails.length) return [];
  const invites = emails.map((email) => ({
    id: crypto.randomUUID(),
    token: newToken(),
    email,
    created_at: now,
    expires_at: now + INVITE_TTL_MS,
    expired: false,
  }));
  await env.DB.batch(
    invites.map((i) =>
      env.DB.prepare(
        "INSERT INTO invites (id, token, lease_id, property_id, email, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
      ).bind(i.id, i.token, lease.id, lease.property_id, i.email, i.created_at, i.expires_at),
    ),
  );
  return invites;
}

async function seatsTaken(env, leaseId, now) {
  const row = await env.DB.prepare(
    "SELECT (SELECT COUNT(*) FROM lease_tenants WHERE lease_id = ?1)" +
      " + (SELECT COUNT(*) FROM invites WHERE lease_id = ?1 AND claimed_by IS NULL AND expires_at > ?2) AS n",
  )
    .bind(leaseId, now)
    .first();
  return row.n;
}

async function createInvite(c, access) {
  const denied = manage(c, access);
  if (denied) return denied;
  const { env } = c;
  const { lease } = access;
  if (lease.ended_at !== null) return fail(409, "lease_ended", "this lease has ended");
  const email = emailOf((await readJSON(c.request)).email);
  if (!email) return fail(400, "bad_email", "that email address doesn't look right");
  const now = Date.now();
  if ((await seatsTaken(env, lease.id, now)) >= LIMITS.tenants) {
    return fail(409, "tenant_limit", `a lease has up to ${LIMITS.tenants} tenants, open invites included`);
  }
  const [invite] = await insertInvites(env, lease, [email], now);
  log("invite.create", { lease: shortId(lease.id), invite: shortId(invite.id) });
  return json(invite, 201);
}

async function revokeInvite(c, access, inviteId) {
  const denied = manage(c, access);
  if (denied) return denied;
  const result = await c.env.DB.prepare("DELETE FROM invites WHERE id = ?1 AND lease_id = ?2 AND claimed_by IS NULL")
    .bind(String(inviteId || ""), access.lease.id)
    .run();
  if (!changed(result)) return notFound("no open invite with that id");
  log("invite.revoke", { lease: shortId(access.lease.id), invite: shortId(inviteId) });
  return json({ ok: true });
}

async function findInvite(env, token) {
  if (!TOKEN_RE.test(token || "")) return null;
  return env.DB.prepare(
    "SELECT i.id, i.lease_id, i.property_id, i.email, i.expires_at, i.claimed_by," +
      " l.due_day, l.starts_at, l.ended_at, un.number AS unit_number," +
      " p.name AS property_name, p.address, p.landlord_id, lu.name AS landlord_name," +
      " (SELECT COUNT(*) FROM lease_tenants t WHERE t.lease_id = i.lease_id) AS tenant_count" +
      " FROM invites i JOIN leases l ON l.id = i.lease_id JOIN units un ON un.id = l.unit_id" +
      " JOIN properties p ON p.id = i.property_id LEFT JOIN users lu ON lu.id = p.landlord_id" +
      " WHERE i.token = ?1",
  )
    .bind(token)
    .first();
}

async function isTenantOn(env, leaseId, user) {
  return !!(await env.DB.prepare("SELECT 1 AS x FROM lease_tenants WHERE lease_id = ?1 AND user_id = ?2")
    .bind(leaseId, user)
    .first());
}

// What the invite page shows before anyone commits to anything. A GET, so it
// only reads. sent_to_you compares the email label with the signed-in
// account's email, to warn gently when a link reached someone else; the
// label itself is never returned.
async function previewInvite(c, token) {
  const { env, user } = c;
  const invite = await findInvite(env, token);
  if (!invite || invite.ended_at !== null)
    return fail(404, "invite_invalid", "this invite link is invalid or was revoked");
  const already = await isTenantOn(env, invite.lease_id, user);
  const now = Date.now();
  if (!already && invite.claimed_by && invite.claimed_by !== user) {
    return fail(409, "invite_claimed", "this invite link was already used");
  }
  if (!already && !invite.claimed_by && invite.expires_at <= now) {
    return fail(410, "invite_expired", "this invite link has expired; ask for a new one");
  }
  const { results: steps } = await env.DB.prepare(
    "SELECT from_month, rent_cents FROM rent_steps WHERE lease_id = ?1 ORDER BY from_month",
  )
    .bind(invite.lease_id)
    .all();
  const lease = { due_day: invite.due_day, starts_at: invite.starts_at };
  return json({
    lease_id: invite.lease_id,
    property: { id: invite.property_id, name: invite.property_name, address: invite.address },
    unit_number: invite.unit_number,
    landlord_name: invite.landlord_name || "Your landlord",
    rent_cents: rentFor(steps, Math.max(firstRentMonth(lease), monthOf(now))),
    due_day: invite.due_day,
    starts_at: invite.starts_at,
    tenant_count: invite.tenant_count,
    sent_to_you: invite.email && c.me.email ? invite.email === c.me.email.toLowerCase() : null,
    already_tenant: already,
    is_landlord: invite.landlord_id === user,
  });
}

// Claiming is two conditional statements. The UPDATE takes the link only if
// nobody has (claimed_by IS NULL), which is what makes it single-use when two
// people open it at once; the INSERT adds the claimer only if they won, the
// lease still runs and it has room. Each is atomic on its own, so this holds
// whether or not a batch is a transaction. If the insert is refused, the link
// is released again so the landlord's invite isn't wasted.
async function claimInvite(c, token) {
  const { env, user } = c;
  const invite = await findInvite(env, token);
  if (!invite || invite.ended_at !== null)
    return fail(404, "invite_invalid", "this invite link is invalid or was revoked");
  const joined = { lease_id: invite.lease_id, property_id: invite.property_id };
  // Neither of these uses the link up: a landlord trying their own link, or
  // a tenant opening it twice, leaves it for the person it was meant for.
  if (invite.landlord_id === user) {
    return fail(400, "invite_own_property", "this is your own property: send the link to your tenant");
  }
  if (await isTenantOn(env, invite.lease_id, user)) return json({ ...joined, already_tenant: true });

  const now = Date.now();
  const [claim, insert] = await env.DB.batch([
    env.DB.prepare(
      "UPDATE invites SET claimed_by = ?2, claimed_at = ?3 WHERE token = ?1 AND claimed_by IS NULL AND expires_at > ?3",
    ).bind(token, user, now),
    env.DB.prepare(
      "INSERT OR IGNORE INTO lease_tenants (lease_id, user_id, property_id, joined_at)" +
        " SELECT i.lease_id, ?2, i.property_id, ?3 FROM invites i JOIN leases l ON l.id = i.lease_id" +
        " WHERE i.token = ?1 AND i.claimed_by = ?2 AND l.ended_at IS NULL" +
        " AND (SELECT COUNT(*) FROM lease_tenants x WHERE x.lease_id = i.lease_id) < ?4" +
        " AND (SELECT COUNT(*) FROM lease_tenants y JOIN leases z ON z.id = y.lease_id" +
        "      WHERE y.user_id = ?2 AND y.property_id = i.property_id AND z.ended_at IS NULL) < ?5",
    ).bind(token, user, now, LIMITS.tenants, LIMITS.leasesHere),
  ]);

  if (!changed(claim)) {
    const fresh = await findInvite(env, token);
    if (fresh && fresh.claimed_by === user && (await isTenantOn(env, invite.lease_id, user))) return json(joined);
    log("invite.claim.rejected", {
      invite: shortId(invite.id),
      reason: fresh && fresh.claimed_by ? "used" : "expired",
    });
    if (fresh && fresh.claimed_by) return fail(409, "invite_claimed", "this invite link was already used");
    return fail(410, "invite_expired", "this invite link has expired; ask for a new one");
  }
  if (!changed(insert)) {
    await env.DB.prepare("UPDATE invites SET claimed_by = NULL, claimed_at = NULL WHERE token = ?1 AND claimed_by = ?2")
      .bind(token, user)
      .run();
    log("invite.claim.rejected", { invite: shortId(invite.id), reason: "full" });
    if (invite.tenant_count >= LIMITS.tenants) return fail(409, "tenant_limit", "this lease is full");
    return fail(409, "lease_limit", `you can hold up to ${LIMITS.leasesHere} leases in one property`);
  }

  await notify(env, invite.property_id, { t: "lease.changed", lease_id: invite.lease_id }, [invite.lease_id]);
  log("invite.claim", { invite: shortId(invite.id), lease: shortId(invite.lease_id), user: shortId(user) });
  return json(joined, 201);
}

/* ------------------------------------------------------------------ rent */

// Months are counted as year * 12 + month (0-11), in UTC. Everything about
// rent is computed from a lease's terms each time a ledger is read, so no job
// has to run on the 1st and no GET ever writes. It stays sound because the
// inputs a tenant has seen never change: due_day and the start date are
// fixed, rent changes only for future months (rent_steps), and a payment
// copies its label and amount.

function monthOf(ms) {
  const d = new Date(ms);
  return d.getUTCFullYear() * 12 + d.getUTCMonth();
}

function monthKey(month) {
  return Math.floor(month / 12) + "-" + String((month % 12) + 1).padStart(2, "0");
}

function parseMonthKey(value) {
  const m = MONTH_RE.exec(String(value || ""));
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) return null;
  return Number(m[1]) * 12 + Number(m[2]) - 1;
}

function monthName(month) {
  return MONTHS[month % 12] + " " + Math.floor(month / 12);
}

function dueOf(month, dueDay) {
  return Date.UTC(Math.floor(month / 12), month % 12, dueDay);
}

function dayStart(ms) {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function monthStart(ms) {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

// The first month whose due date falls on or after the start date. A lease
// starting on the 15th with rent due on the 1st owes its first rent on the
// 1st of the next month (a partial month is a one-off charge).
function firstRentMonth(lease) {
  const start = monthOf(lease.starts_at);
  return dueOf(start, lease.due_day) >= lease.starts_at ? start : start + 1;
}

// The rent for a month is the latest step starting at or before it. steps is
// sorted by from_month.
function rentFor(steps, month) {
  let cents = 0;
  for (const step of steps) {
    if (step.from_month > month) break;
    cents = step.rent_cents;
  }
  return cents;
}

async function loadLedger(env, lease, now) {
  const [steps, charges, payments] = await Promise.all([
    env.DB.prepare("SELECT from_month, rent_cents FROM rent_steps WHERE lease_id = ?1 ORDER BY from_month")
      .bind(lease.id)
      .all(),
    env.DB.prepare("SELECT id, kind, label, amount_cents, due_at FROM charges WHERE lease_id = ?1")
      .bind(lease.id)
      .all(),
    env.DB.prepare(
      "SELECT p.item_ref, p.label, p.amount_cents, p.method, p.card_last4, p.confirmation, p.paid_at, u.name AS paid_by_name" +
        " FROM payments p LEFT JOIN users u ON u.id = p.paid_by WHERE p.lease_id = ?1",
    )
      .bind(lease.id)
      .all(),
  ]);
  return {
    steps: steps.results,
    ...ledgerOf(lease, steps.results, charges.results, payments.results, now),
  };
}

// Every item of one lease as of `now`, oldest first.
//
// - A month's rent item exists from the 1st of that month (UTC), from the
//   first rent month up to the current one.
// - The term's last day caps rent, except that a paid item always shows, so
//   moving the end date earlier never hides a payment.
// - An unpaid item is overdue once its due day is over.
function ledgerOf(lease, steps, charges, payments, now) {
  const paid = new Map(payments.map((p) => [p.item_ref, p]));
  const items = [];
  const first = firstRentMonth(lease);
  const current = monthOf(now);
  for (let m = Math.max(first, current - RENT_HISTORY_MONTHS + 1); m <= current; m++) {
    const ref = "rent:" + monthKey(m);
    const payment = paid.get(ref);
    const due = dueOf(m, lease.due_day);
    const amount = rentFor(steps, m);
    if (!payment && ((lease.ends_at !== null && lease.ends_at !== undefined && due > lease.ends_at) || amount <= 0)) {
      continue;
    }
    items.push(itemOf(ref, "rent", "Rent, " + monthName(m), amount, due, payment, now));
  }
  for (const charge of charges) {
    const ref = "charge:" + charge.id;
    const label = charge.label || CHARGE_KINDS[charge.kind] || "Charge";
    items.push({
      ...itemOf(ref, charge.kind, label, charge.amount_cents, charge.due_at, paid.get(ref), now),
      charge_id: charge.id,
    });
  }
  items.sort((a, b) => a.due_at - b.due_at || a.ref.localeCompare(b.ref));

  let balance = 0;
  let overdue = 0;
  let nextDue = null;
  for (const item of items) {
    if (item.status === "paid") continue;
    balance += item.amount_cents;
    if (item.status === "overdue") overdue += item.amount_cents;
    if (nextDue === null || item.due_at < nextDue) nextDue = item.due_at;
  }

  // The next month's rent, for "coming up" on the tenant's home.
  let nextRent = null;
  const upcoming = Math.max(first, current + 1);
  const upcomingDue = dueOf(upcoming, lease.due_day);
  const running = lease.ended_at === null || lease.ended_at === undefined;
  if (running && (lease.ends_at === null || lease.ends_at === undefined || upcomingDue <= lease.ends_at)) {
    const amount = rentFor(steps, upcoming);
    if (amount > 0) nextRent = { month: monthKey(upcoming), due_at: upcomingDue, amount_cents: amount };
  }

  return {
    items,
    rent_cents: rentFor(steps, Math.max(first, current)),
    balance_cents: balance,
    overdue_cents: overdue,
    next_due: nextDue,
    next_rent: nextRent,
  };
}

function itemOf(ref, kind, label, amount, due, payment, now) {
  return {
    ref,
    kind,
    label: payment ? payment.label : label,
    amount_cents: payment ? payment.amount_cents : amount,
    due_at: due,
    status: payment ? "paid" : now > due + OVERDUE_AFTER_MS ? "overdue" : "open",
    paid: payment
      ? {
          confirmation: payment.confirmation,
          method: payment.method,
          card_last4: payment.card_last4 || "",
          paid_at: payment.paid_at,
          by_name: payment.paid_by_name || "",
        }
      : null,
  };
}

/* --------------------------------------------------------- charges & pay */

async function addCharge(c, access) {
  const denied = manage(c, access);
  if (denied) return denied;
  const { env } = c;
  const { lease } = access;
  if (lease.ended_at !== null) return fail(409, "lease_ended", "this lease has ended");
  const body = await readJSON(c.request);
  const kind = Object.hasOwn(CHARGE_KINDS, body.kind) ? body.kind : null;
  if (!kind) return fail(400, "bad_kind", "pick what the charge is for");
  const amount = cents(body.amount_cents);
  if (!amount) return fail(400, "bad_amount", "a charge is between $0.01 and $100,000");
  const dueAt = body.due_on ? dateOn(body.due_on) : dayStart(Date.now());
  if (dueAt === null) return fail(400, "bad_due", "pick a due date");
  const label = oneLine(body.label, MAX.label) || CHARGE_KINDS[kind];
  const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM charges WHERE lease_id = ?1").bind(lease.id).first();
  if (count.n >= LIMITS.charges) return fail(403, "charge_limit", `a lease holds up to ${LIMITS.charges} charges`);

  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO charges (id, lease_id, property_id, kind, label, amount_cents, due_at, created_at)" +
      " VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
  )
    .bind(id, lease.id, lease.property_id, kind, label, amount, dueAt, Date.now())
    .run();
  await notify(
    env,
    lease.property_id,
    { t: "ledger.changed", lease_id: lease.id, unit: lease.unit_number, kind: "charge", cents: amount },
    [lease.id],
  );
  log("charge.create", { lease: shortId(lease.id), charge: shortId(id), kind });
  return json({ id, kind, label, amount_cents: amount, due_at: dueAt }, 201);
}

// Void is one conditional DELETE, and paying is one conditional INSERT, so
// whichever of the two runs first wins and the other is refused.
async function voidCharge(c, access, chargeId) {
  const denied = manage(c, access);
  if (denied) return denied;
  const { env } = c;
  const { lease } = access;
  const id = String(chargeId || "");
  const result = await env.DB.prepare(
    "DELETE FROM charges WHERE id = ?1 AND lease_id = ?2" +
      " AND NOT EXISTS (SELECT 1 FROM payments WHERE lease_id = ?2 AND item_ref = 'charge:' || ?1)",
  )
    .bind(id, lease.id)
    .run();
  if (!changed(result)) {
    const exists = await env.DB.prepare("SELECT 1 AS x FROM charges WHERE id = ?1 AND lease_id = ?2")
      .bind(id, lease.id)
      .first();
    if (exists) return fail(409, "charge_paid", "this charge is paid; it can't be voided");
    return notFound("charge not found");
  }
  await notify(
    env,
    lease.property_id,
    { t: "ledger.changed", lease_id: lease.id, unit: lease.unit_number, kind: "void" },
    [lease.id],
  );
  log("charge.void", { lease: shortId(lease.id), charge: shortId(id) });
  return json({ ok: true });
}

// Simulated payments. Nothing leaves this service and no money moves.
//
// Tenants pay by (test) card; the landlord records cash or a check. The
// client sends the items it showed and the total it showed, and both are
// checked against a fresh ledger, so a stale screen can't pay the wrong
// amount. Each item is one INSERT OR IGNORE against UNIQUE(lease_id,
// item_ref): two roommates paying the same rent at the same moment get one
// row, and the second is told it was already paid.
async function pay(c, access) {
  const { env, user } = c;
  const { lease, role } = access;
  const body = await readJSON(c.request);
  const method = String(body.method || "");
  if (role === TENANT) {
    if (method !== "card") return fail(400, "bad_method", "tenants pay by card");
  } else {
    const denied = manage(c, access);
    if (denied) return denied;
    if (method !== "cash" && method !== "check") return fail(400, "bad_method", "record a cash or check payment");
  }

  const refs = [...new Set(Array.isArray(body.refs) ? body.refs.filter((r) => typeof r === "string") : [])];
  if (!refs.length) return fail(400, "nothing_to_pay", "pick something to pay");
  if (refs.length > LIMITS.payItems) return fail(400, "too_many", `pay up to ${LIMITS.payItems} items at once`);

  const now = Date.now();
  const ledger = await loadLedger(env, lease, now);
  const open = new Map(ledger.items.filter((i) => i.status !== "paid").map((i) => [i.ref, i]));
  const items = refs.map((ref) => open.get(ref));
  if (items.some((i) => !i)) return fail(409, "items_changed", "something on this bill changed; take another look");
  const total = items.reduce((sum, i) => sum + i.amount_cents, 0);
  if (body.expected_cents !== total) return fail(409, "amount_changed", "the amount changed; take another look");

  let last4 = "";
  if (method === "card") {
    const card = TEST_CARDS[body.card];
    if (!card) return fail(400, "bad_card", "use one of the test cards");
    if (!card.ok) {
      log("pay.declined", { lease: shortId(lease.id), items: items.length });
      return fail(402, "card_declined", "the test card was declined (that's what 4000 0000 0000 0002 does)");
    }
    last4 = card.last4;
  }

  const confirmation = newCode();
  const results = await env.DB.batch(
    items.map((item) =>
      env.DB.prepare(
        "INSERT OR IGNORE INTO payments" +
          " (id, lease_id, property_id, item_ref, label, amount_cents, method, card_last4, confirmation, paid_by, paid_at)" +
          " SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11" +
          " WHERE ?12 = 1 OR EXISTS (SELECT 1 FROM charges WHERE id = ?13 AND lease_id = ?2)",
      ).bind(
        crypto.randomUUID(),
        lease.id,
        lease.property_id,
        item.ref,
        item.label,
        item.amount_cents,
        method,
        last4,
        confirmation,
        user,
        now,
        item.kind === "rent" ? 1 : 0,
        item.charge_id || null,
      ),
    ),
  );
  const paid = [];
  const skipped = [];
  let paidCents = 0;
  items.forEach((item, i) => {
    if (changed(results[i])) {
      paid.push(item.ref);
      paidCents += item.amount_cents;
    } else {
      skipped.push(item.ref);
    }
  });
  if (!paid.length) {
    log("pay.conflict", { lease: shortId(lease.id), items: items.length });
    return fail(409, "already_paid", "someone paid this a moment ago");
  }

  await notify(
    env,
    lease.property_id,
    {
      t: "ledger.changed",
      lease_id: lease.id,
      unit: lease.unit_number,
      kind: method === "card" ? "paid" : "recorded",
      by: c.me.name,
      by_id: user,
      cents: paidCents,
    },
    [lease.id],
  );
  log(method === "card" ? "pay.card" : "pay.recorded", {
    lease: shortId(lease.id),
    items: paid.length,
    skipped: skipped.length,
  });
  return json({ confirmation, paid, skipped, total_cents: paidCents }, 201);
}

async function receipt(c, access, code) {
  if (!CODE_RE.test(code || "")) return notFound("receipt not found");
  const { results } = await c.env.DB.prepare(
    "SELECT p.item_ref, p.label, p.amount_cents, p.method, p.card_last4, p.paid_at, u.name AS paid_by_name" +
      " FROM payments p LEFT JOIN users u ON u.id = p.paid_by WHERE p.lease_id = ?1 AND p.confirmation = ?2 ORDER BY p.item_ref",
  )
    .bind(access.lease.id, code)
    .all();
  if (!results.length) return notFound("receipt not found");
  const { lease } = access;
  return json({
    confirmation: code,
    lease_id: lease.id,
    unit_number: lease.unit_number,
    property: { name: lease.property_name, address: lease.address },
    paid_at: results[0].paid_at,
    paid_by_name: results[0].paid_by_name || "",
    method: results[0].method,
    card_last4: results[0].card_last4,
    lines: results.map((r) => ({ ref: r.item_ref, label: r.label, amount_cents: r.amount_cents })),
    total_cents: results.reduce((sum, r) => sum + r.amount_cents, 0),
  });
}

/* --------------------------------------------------------- announcements */

async function listAnnouncements(c, access) {
  const { results } = await c.env.DB.prepare(
    "SELECT a.id, a.title, a.body, a.pinned, a.posted_at, u.name AS author_name" +
      " FROM announcements a LEFT JOIN users u ON u.id = a.author_id" +
      " WHERE a.property_id = ?1 ORDER BY a.pinned DESC, a.posted_at DESC LIMIT 100",
  )
    .bind(access.property.id)
    .all();
  return json(results.map((a) => ({ ...a, pinned: !!a.pinned })));
}

async function postAnnouncement(c, access) {
  const denied = manage(c, access);
  if (denied) return denied;
  const { env } = c;
  const body = await readJSON(c.request);
  const title = oneLine(body.title, MAX.title);
  const text = multiLine(body.body, MAX.announcement);
  if (!title) return fail(400, "title_required", "give the announcement a title");
  const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM announcements WHERE property_id = ?1")
    .bind(access.property.id)
    .first();
  if (count.n >= LIMITS.announcements) {
    return fail(
      403,
      "announcement_limit",
      `a property keeps up to ${LIMITS.announcements} announcements; delete an old one`,
    );
  }
  const post = {
    id: crypto.randomUUID(),
    title,
    body: text,
    pinned: !!body.pinned,
    posted_at: Date.now(),
    author_name: c.me.name,
  };
  await env.DB.prepare(
    "INSERT INTO announcements (id, property_id, author_id, title, body, pinned, posted_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
  )
    .bind(post.id, access.property.id, c.user, title, text, post.pinned ? 1 : 0, post.posted_at)
    .run();
  await notify(env, access.property.id, { t: "announcement.posted", id: post.id, title, pinned: post.pinned }, "all");
  log("announcement.post", { property: shortId(access.property.id), post: shortId(post.id), pinned: post.pinned });
  return json(post, 201);
}

async function updateAnnouncement(c, access, postId) {
  const denied = manage(c, access);
  if (denied) return denied;
  const { env } = c;
  const body = await readJSON(c.request);
  const current = await env.DB.prepare("SELECT * FROM announcements WHERE id = ?1 AND property_id = ?2")
    .bind(String(postId || ""), access.property.id)
    .first();
  if (!current) return notFound("announcement not found");
  const title = body.title === undefined ? current.title : oneLine(body.title, MAX.title);
  const text = body.body === undefined ? current.body : multiLine(body.body, MAX.announcement);
  const pinned = body.pinned === undefined ? !!current.pinned : !!body.pinned;
  if (!title) return fail(400, "title_required", "give the announcement a title");
  await env.DB.prepare("UPDATE announcements SET title = ?1, body = ?2, pinned = ?3 WHERE id = ?4")
    .bind(title, text, pinned ? 1 : 0, current.id)
    .run();
  await notify(env, access.property.id, { t: "announcement.updated", id: current.id }, "all");
  log("announcement.update", { post: shortId(current.id), pinned });
  return json({ id: current.id, title, body: text, pinned, posted_at: current.posted_at });
}

async function deleteAnnouncement(c, access, postId) {
  const denied = manage(c, access);
  if (denied) return denied;
  const result = await c.env.DB.prepare("DELETE FROM announcements WHERE id = ?1 AND property_id = ?2")
    .bind(String(postId || ""), access.property.id)
    .run();
  if (!changed(result)) return notFound("announcement not found");
  await notify(c.env, access.property.id, { t: "announcement.deleted", id: postId }, "all");
  log("announcement.delete", { post: shortId(postId) });
  return json({ ok: true });
}

/* --------------------------------------------------------------- tickets */

const TICKET_FIELDS =
  "k.id, k.lease_id, k.category, k.title, k.status, k.entry_ok, k.comment_count, k.created_by, k.created_at, k.updated_at";

function ticketSummary(row, access) {
  return {
    id: row.id,
    lease_id: row.lease_id,
    category: row.category,
    title: row.title,
    status: row.status,
    entry_ok: !!row.entry_ok,
    comment_count: row.comment_count || 0,
    unit_number: row.unit_number,
    created_by_name: row.created_by_name || "",
    is_yours: row.created_by === access.user,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// The landlord sees every request in the property; a tenant sees the ones on
// their own leases, which the subquery reads from the database rather than
// from anything the client sent.
async function listTickets(c, access, params) {
  const status = params.get("status");
  const lease = params.get("lease");
  // Bind exactly the parameters the query uses: SQLite counts them by the
  // highest index, and an extra one is an error.
  const args = [access.property.id];
  let sql =
    `SELECT ${TICKET_FIELDS}, un.number AS unit_number, u.name AS created_by_name` +
    " FROM tickets k JOIN leases l ON l.id = k.lease_id JOIN units un ON un.id = l.unit_id" +
    " LEFT JOIN users u ON u.id = k.created_by WHERE k.property_id = ?1";
  if (access.role === TENANT) {
    args.push(c.user);
    sql +=
      " AND k.lease_id IN (SELECT t.lease_id FROM lease_tenants t JOIN leases x ON x.id = t.lease_id" +
      ` WHERE t.user_id = ?${args.length} AND t.property_id = ?1 AND x.ended_at IS NULL)`;
  }
  if (isId(lease)) {
    args.push(lease);
    sql += ` AND k.lease_id = ?${args.length}`;
  }
  if (status === "open") sql += " AND k.status != 'resolved'";
  if (status === "resolved") sql += " AND k.status = 'resolved'";
  sql += " ORDER BY k.updated_at DESC LIMIT 200";
  const { results } = await c.env.DB.prepare(sql)
    .bind(...args)
    .all();
  return json(results.map((row) => ticketSummary(row, access)));
}

async function createTicket(c, access) {
  const { env, user } = c;
  const { lease } = access;
  if (access.role !== TENANT) return fail(403, "tenants_only", "requests come from the tenants on a lease");
  const body = await readJSON(c.request);
  const category = CATEGORIES.includes(body.category) ? body.category : null;
  if (!category) return fail(400, "bad_category", "pick a category");
  const title = oneLine(body.title, MAX.title);
  if (!title) return fail(400, "title_required", "say what needs fixing");
  const text = multiLine(body.body, MAX.body);
  const open = await env.DB.prepare("SELECT COUNT(*) AS n FROM tickets WHERE lease_id = ?1 AND status != 'resolved'")
    .bind(lease.id)
    .first();
  if (open.n >= LIMITS.openTickets) {
    return fail(403, "ticket_limit", `a lease can have up to ${LIMITS.openTickets} open requests`);
  }
  const now = Date.now();
  const id = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO tickets (id, property_id, lease_id, created_by, category, title, body, entry_ok, status, comment_count, created_at, updated_at)" +
        " VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'submitted', 0, ?9, ?9)",
    ).bind(id, lease.property_id, lease.id, user, category, title, text, body.entry_ok ? 1 : 0, now),
    env.DB.prepare(
      "INSERT INTO ticket_events (id, ticket_id, property_id, kind, author_id, body, status, at)" +
        " VALUES (?1, ?2, ?3, 'status', ?4, '', 'submitted', ?5)",
    ).bind(crypto.randomUUID(), id, lease.property_id, user, now),
  ]);
  await notify(
    env,
    lease.property_id,
    { t: "ticket.updated", id, lease_id: lease.id, status: "submitted", created: true, unit: lease.unit_number },
    [lease.id],
  );
  log("ticket.create", { lease: shortId(lease.id), ticket: shortId(id), category });
  return json({ id, lease_id: lease.id, status: "submitted" }, 201);
}

// The thread is the database's rows plus whatever the property's object is
// still holding for its next flush. The object is asked first and the
// database second: the flush writes to the database before it deletes from
// its buffer, so a comment that has left the buffer by the time we ask is
// already in the database when we read it. Asked the other way round, a
// comment flushed in between would be in neither answer.
async function ticketDetail(c, access) {
  const { env } = c;
  const { ticket } = access;
  const pending = await pendingComments(env, ticket.property_id, ticket.id);
  const { results } = await env.DB.prepare(
    "SELECT e.id, e.kind, e.author_id, e.body, e.status, e.at, u.name AS author_name" +
      " FROM ticket_events e LEFT JOIN users u ON u.id = e.author_id WHERE e.ticket_id = ?1 ORDER BY e.at, e.id",
  )
    .bind(ticket.id)
    .all();
  const events = new Map();
  for (const row of results) events.set(row.id, row);
  for (const row of pending) {
    if (!events.has(row.id)) {
      events.set(row.id, {
        id: row.id,
        kind: "comment",
        author_id: row.author_id,
        body: row.body,
        status: "",
        at: row.at,
        author_name: row.author_name,
      });
    }
  }
  const thread = [...events.values()]
    .sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))
    .map((e) => ({
      id: e.id,
      kind: e.kind,
      author_id: e.author_id,
      author_name: e.author_name || "Someone",
      role: e.author_id === ticket.landlord_id ? LANDLORD : TENANT,
      body: e.body,
      status: e.status,
      at: e.at,
    }));
  return json({
    ticket: {
      ...ticketSummary(ticket, access),
      body: ticket.body,
      property_id: ticket.property_id,
    },
    role: access.role,
    can_write: access.role === LANDLORD && c.me.landlord_plan,
    can_withdraw: ticket.created_by === c.user && ticket.status === "submitted",
    events: thread,
  });
}

async function updateTicket(c, access) {
  const denied = manage(c, access);
  if (denied) return denied;
  const { env } = c;
  const { ticket } = access;
  const status = (await readJSON(c.request)).status;
  if (!STATUSES.includes(status)) return fail(400, "bad_status", "pick a status");
  if (status === ticket.status) return json({ id: ticket.id, status });
  const now = Date.now();
  const [updated] = await env.DB.batch([
    env.DB.prepare("UPDATE tickets SET status = ?1, updated_at = ?2 WHERE id = ?3").bind(status, now, ticket.id),
    env.DB.prepare(
      "INSERT INTO ticket_events (id, ticket_id, property_id, kind, author_id, body, status, at)" +
        " SELECT ?1, ?2, ?3, 'status', ?4, '', ?5, ?6 WHERE EXISTS (SELECT 1 FROM tickets WHERE id = ?2)",
    ).bind(crypto.randomUUID(), ticket.id, ticket.property_id, c.user, status, now),
  ]);
  if (!changed(updated)) return notFound("request not found");
  await notify(
    env,
    ticket.property_id,
    {
      t: "ticket.updated",
      id: ticket.id,
      lease_id: ticket.lease_id,
      status,
      title: ticket.title,
      unit: ticket.unit_number,
    },
    [ticket.lease_id],
  );
  log("ticket.status", { ticket: shortId(ticket.id), from: ticket.status, to: status });
  return json({ id: ticket.id, status });
}

// Only the tenant who filed it, and only before the landlord has picked it
// up. The status check is in the DELETE itself, so a withdrawal racing an
// acknowledgement can't win after the fact.
async function withdrawTicket(c, access) {
  const { env, user } = c;
  const { ticket } = access;
  const [removed] = await env.DB.batch([
    env.DB.prepare("DELETE FROM tickets WHERE id = ?1 AND created_by = ?2 AND status = 'submitted'").bind(
      ticket.id,
      user,
    ),
    env.DB.prepare(
      "DELETE FROM ticket_events WHERE ticket_id = ?1 AND NOT EXISTS (SELECT 1 FROM tickets WHERE id = ?1)",
    ).bind(ticket.id),
  ]);
  if (!changed(removed)) {
    if (ticket.created_by !== user)
      return fail(403, "not_yours", "only the person who filed a request can withdraw it");
    return fail(409, "ticket_locked", "your landlord has already picked this up");
  }
  await notify(env, ticket.property_id, { t: "ticket.withdrawn", id: ticket.id, lease_id: ticket.lease_id }, [
    ticket.lease_id,
  ]);
  log("ticket.withdraw", { ticket: shortId(ticket.id) });
  return json({ ok: true });
}

// Comments are checked here, against the database and the landlord's live
// plan, then handed to the property's object, which relays them at once and
// writes them to the database in one batch per burst. The object's reply is
// the stored comment, so the author's tab needs no separate acknowledgement.
async function postComment(c, access) {
  const { env } = c;
  const { ticket } = access;
  if (access.role === LANDLORD && !c.me.landlord_plan) return planRequired(c);
  const text = multiLine((await readJSON(c.request)).body, MAX.body);
  if (!text) return fail(400, "body_required", "write something first");
  if (ticket.comment_count >= LIMITS.comments) {
    return fail(403, "comment_limit", `a request holds up to ${LIMITS.comments} comments`);
  }
  const res = await internal(env, ticket.property_id, "/__comment", {
    property_id: ticket.property_id,
    ticket_id: ticket.id,
    lease_id: ticket.lease_id,
    author_id: c.user,
    author_name: c.me.name,
    role: access.role,
    body: text,
  });
  if (!res.ok) return fail(503, "busy", "comments are backed up; try again in a few seconds");
  const comment = await res.json();
  log("comment.post", { ticket: shortId(ticket.id), user: shortId(c.user), len: text.length });
  return json(comment, 201);
}

/* -------------------------------------------------------------- realtime */

// The realtime route. propertyAccess already confirmed, from the database on
// this very request, that the caller is the landlord or on a running lease
// here. The X-Keyring-* headers are set after stripping anything a client
// sent, so the object can trust them the way it trusts X-Yard-*. The edge
// only signs in sockets opened from this project's own pages, so another
// site can't open one as a signed-in visitor.
async function connectProperty(c, access) {
  const { request, env } = c;
  if (request.headers.get("Upgrade") !== "websocket") {
    return fail(426, "upgrade_required", "expected a WebSocket");
  }
  const headers = new Headers(request.headers);
  for (const key of [...headers.keys()]) {
    if (key.toLowerCase().startsWith("x-keyring-")) headers.delete(key);
  }
  headers.set("X-Keyring-Property", access.property.id);
  headers.set("X-Keyring-Role", access.role);
  headers.set("X-Keyring-Leases", access.leases.join(","));
  headers.set("X-Keyring-Name", encodeURIComponent(c.me.name));
  log("ws.forward", { property: shortId(access.property.id), user: shortId(c.user), role: access.role });
  return objectFor(env, access.property.id).fetch(new Request(request, { headers }));
}

function objectFor(env, propertyId) {
  return env.PROPERTIES.get(env.PROPERTIES.idFromName(propertyId));
}

// Handler-to-object calls that are not upgrades. Clients cannot reach the
// object directly (the handler only forwards the upgrade), so paths under
// /__ are private by construction. Every call names the property, so an
// object that has never had a socket still knows whose it is.
async function internal(env, propertyId, path, body) {
  try {
    return await objectFor(env, propertyId).fetch("https://keyring.internal" + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, property_id: propertyId }),
    });
  } catch (err) {
    console.error(`[keyring] internal.failed path=${path} property=${shortId(propertyId)}`, err && err.stack);
    return new Response(null, { status: 502 });
  }
}

// A read, so a GET: the comments the object hasn't flushed yet.
async function pendingComments(env, propertyId, ticketId) {
  try {
    const res = await objectFor(env, propertyId).fetch("https://keyring.internal/__pending?ticket=" + ticketId);
    return res.ok ? await res.json() : [];
  } catch (err) {
    console.error(`[keyring] internal.failed path=/__pending property=${shortId(propertyId)}`, err && err.stack);
    return [];
  }
}

// Tells everyone concerned that something changed. `to` is "all" or a list
// of lease ids; the landlord is always included. Events are hints: clients
// re-fetch what they show, so a lost event costs freshness, never data.
async function notify(env, propertyId, event, to) {
  const res = await internal(env, propertyId, "/__notify", { event, to });
  return res.ok;
}

// Closes the sockets of people who just lost access here. Someone who still
// holds another lease in the property gets 4004 and reconnects with fresh
// headers; everyone else gets 4003 and stops.
async function kickUsers(env, propertyId, userIds) {
  const ids = [...new Set(userIds.filter(Boolean))];
  if (!ids.length) return 0;
  const kicks = [];
  for (let i = 0; i < ids.length; i += FANOUT) {
    const rows = await Promise.all(
      ids.slice(i, i + FANOUT).map((id) =>
        env.DB.prepare(
          "SELECT COUNT(*) AS n FROM lease_tenants t JOIN leases l ON l.id = t.lease_id" +
            " WHERE t.user_id = ?1 AND t.property_id = ?2 AND l.ended_at IS NULL",
        )
          .bind(id, propertyId)
          .first(),
      ),
    );
    rows.forEach((row, j) => kicks.push({ user_id: ids[i + j], code: row.n ? CLOSE_CHANGED : CLOSE_REMOVED }));
  }
  const res = await internal(env, propertyId, "/__kick", { kicks });
  const out = await res.json().catch(() => ({}));
  return out.closed || 0;
}

/* -------------------------------------------------------------- Property */

// One instance per property. The runtime creates it when the first request
// for that property arrives and may retire it when things go quiet, so
// instance fields are a cache at best: what matters is in ctx.storage (the
// comment buffer, meta) or attached to a connection.
//
// Over the socket, the object only ever sends, apart from one thing it
// receives: typing indicators. Everything that changes data arrives through
// the handler, which checked access in the database first.
//
//   object → client                                   client → object
//   hello { cid, role }                                typing { ticket_id, lease_id }
//   comment { ticket_id, comment }
//   typing { ticket_id, user_id, name }
//   announcement.posted|updated|deleted · ticket.updated|withdrawn
//   ledger.changed · lease.changed · property.changed
//   error { code, message }
//
// Close codes: 4001 full (retry later), 4002 deleted, 4003 removed (both
// final), 4004 access changed (reconnect now). 1000 "Session limit reached"
// is the platform's 24-hour cap, and the client reconnects at once.
export class Property {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.meta = null;
    this.ctx.blockConcurrencyWhile(async () => {
      this.createTables();
      this.meta = { ...freshMeta(), ...((await this.ctx.storage.get("meta")) || {}) };
      log("property.wake", { property: shortId(this.meta.property), live: this.ctx.getWebSockets().length });
    });
  }

  createTables() {
    // Comments waiting for the next flush to env.DB.
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS pending (" +
        " id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL, lease_id TEXT NOT NULL, author_id TEXT NOT NULL," +
        " author_name TEXT NOT NULL, role TEXT NOT NULL, body TEXT NOT NULL, at INTEGER NOT NULL)",
    );
    this.ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS idx_pending_ticket ON pending (ticket_id, at)");
  }

  async fetch(request) {
    if (request.headers.get("Upgrade") === "websocket") return this.join(request);

    const url = new URL(request.url);
    if (url.pathname === "/__pending" && request.method === "GET") return this.pending(url.searchParams.get("ticket"));
    if (request.method !== "POST") return new Response("Not found", { status: 404 });
    if (url.pathname === "/__notify") return this.relay(request);
    if (url.pathname === "/__comment") return this.comment(request);
    if (url.pathname === "/__kick") return this.kick(request);
    if (url.pathname === "/__delete") return this.destroy(request);
    return new Response("Not found", { status: 404 });
  }

  /* connections */

  async join(request) {
    const h = request.headers;
    const userId = h.get("X-Yard-User-Id") || "";
    if (!userId) return new Response("sign in", { status: 401 });
    const propertyId = h.get("X-Keyring-Property") || "";
    const role = h.get("X-Keyring-Role") === LANDLORD ? LANDLORD : TENANT;
    const leases = (h.get("X-Keyring-Leases") || "").split(",").filter(isId).slice(0, LIMITS.leasesHere);
    const name = oneLine(safeDecode(h.get("X-Keyring-Name")), MAX.name) || "Someone";
    await this.remember(propertyId);

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    // Accept, explain, close: a refused upgrade would reach the browser as a
    // bare failure with nothing to show.
    const live = this.ctx.getWebSockets().length;
    if (this.meta.deleted || live >= LIMITS.peers) {
      const deleted = !!this.meta.deleted;
      this.ctx.acceptWebSocket(server);
      send(server, {
        t: "error",
        code: deleted ? "deleted" : "full",
        message: deleted ? "This property was deleted." : "Too many people are connected right now.",
      });
      server.close(deleted ? CLOSE_DELETED : CLOSE_FULL, deleted ? "Property deleted" : "Property is full");
      log(deleted ? "property.tombstone" : "property.full", { property: shortId(propertyId), live });
      return new Response(null, { status: 101, webSocket: client });
    }

    // The attachment is the only thing a frame can be traced back to: a
    // WebSocket frame carries no headers. Tags make "everyone on this lease"
    // and "this person's sockets" lookups instead of loops; the u: prefix
    // keeps a user id from ever colliding with the landlord tag.
    const peer = { cid: crypto.randomUUID().slice(0, 8), user_id: userId, name, role, leases };
    server.serializeAttachment(peer);
    const tags = ["u:" + userId, ...(role === LANDLORD ? [LANDLORD] : leases.map((l) => "lease:" + l))];
    this.ctx.acceptWebSocket(server, tags);
    send(server, { t: "hello", cid: peer.cid, role });
    log("peer.join", { property: shortId(propertyId), cid: peer.cid, user: shortId(userId), role, peers: live + 1 });
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, raw) {
    const me = attachment(ws);
    if (!me) return;
    let msg = null;
    if (typeof raw === "string" && raw.length <= 512) {
      try {
        msg = JSON.parse(raw);
      } catch {
        msg = null;
      }
    }
    // Typing is relayed to the landlord and the lease it names, never stored.
    // A tenant may only name a lease they are on; the landlord, any lease
    // here.
    if (msg && msg.t === "typing" && isId(msg.ticket_id) && isId(msg.lease_id)) {
      if (me.role !== LANDLORD && !me.leases.includes(msg.lease_id)) {
        log("typing.rejected", { property: shortId(this.meta.property), cid: me.cid });
        return;
      }
      this.sendTo({ t: "typing", ticket_id: msg.ticket_id, user_id: me.user_id, name: me.name }, [msg.lease_id], ws);
      return;
    }
    log("frame.rejected", { property: shortId(this.meta.property), cid: me.cid });
  }

  async webSocketClose(ws, code, reason) {
    const me = attachment(ws);
    if (me) log("peer.leave", { property: shortId(this.meta.property), cid: me.cid, code, reason: reason || "-" });
    try {
      ws.close(1000, "bye");
    } catch {
      // Already closed from this side.
    }
  }

  async webSocketError(ws, err) {
    const me = attachment(ws);
    if (me) log("peer.error", { property: shortId(this.meta.property), cid: me.cid, error: err && err.name });
  }

  /* handler-only routes */

  // An event the handler wants delivered. Nothing is stored.
  async relay(request) {
    const { event, to, property_id: propertyId } = await readJSON(request);
    await this.remember(propertyId);
    if (!event || typeof event.t !== "string") return json({ error: "bad event" }, 400);
    const sent = this.sendTo(event, to === "all" ? "all" : Array.isArray(to) ? to.filter(isId) : []);
    log("relay", { property: shortId(this.meta.property), t: event.t, sent });
    return json({ ok: true, sent });
  }

  // A comment the handler has already authorized: numbered, buffered,
  // relayed, and left for the alarm to write to the database.
  async comment(request) {
    const body = await readJSON(request);
    await this.remember(body.property_id);
    const sql = this.ctx.storage.sql;
    const waiting = sql.exec("SELECT COUNT(*) AS n FROM pending").one().n;
    if (waiting >= LIMITS.pending) {
      log("comment.busy", { property: shortId(this.meta.property), pending: waiting });
      return json({ error: "busy" }, 503);
    }
    const comment = {
      id: crypto.randomUUID(),
      kind: "comment",
      author_id: String(body.author_id || ""),
      author_name: oneLine(body.author_name, MAX.name) || "Someone",
      role: body.role === LANDLORD ? LANDLORD : TENANT,
      body: String(body.body || ""),
      status: "",
      at: Date.now(),
    };
    sql.exec(
      "INSERT INTO pending (id, ticket_id, lease_id, author_id, author_name, role, body, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      comment.id,
      String(body.ticket_id),
      String(body.lease_id),
      comment.author_id,
      comment.author_name,
      comment.role,
      comment.body,
      comment.at,
    );
    this.sendTo({ t: "comment", ticket_id: body.ticket_id, comment }, [body.lease_id]);
    // One alarm per burst: the first comment arms it, the rest ride along.
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + FLUSH_MS);
    log("comment.buffer", { property: shortId(this.meta.property), pending: waiting + 1 });
    return json(comment);
  }

  pending(ticketId) {
    const rows = this.ctx.storage.sql
      .exec(
        "SELECT id, author_id, author_name, role, body, at FROM pending WHERE ticket_id = ? ORDER BY at",
        String(ticketId || ""),
      )
      .toArray();
    return json(rows);
  }

  // Lost access: close this person's sockets here now, not on their next
  // reconnect.
  async kick(request) {
    const { kicks, property_id: propertyId } = await readJSON(request);
    await this.remember(propertyId);
    let closed = 0;
    for (const k of Array.isArray(kicks) ? kicks : []) {
      const code = k.code === CLOSE_CHANGED ? CLOSE_CHANGED : CLOSE_REMOVED;
      for (const socket of this.ctx.getWebSockets("u:" + k.user_id)) {
        send(socket, {
          t: "error",
          code: code === CLOSE_REMOVED ? "removed" : "access_changed",
          message: code === CLOSE_REMOVED ? "You no longer have access to this property." : "Your access here changed.",
        });
        try {
          socket.close(code, code === CLOSE_REMOVED ? "Removed" : "Access changed");
        } catch {
          // Already gone.
        }
        closed += 1;
      }
    }
    log("kick", { property: shortId(this.meta.property), people: (kicks || []).length, closed });
    return json({ ok: true, closed });
  }

  // Deleted: close everyone, drop every row, and leave a tombstone so a join
  // the handler forwarded a moment before the delete can't reopen the room.
  async destroy(request) {
    await this.remember((await readJSON(request)).property_id);
    const sockets = this.ctx.getWebSockets();
    for (const socket of sockets) {
      send(socket, { t: "error", code: "deleted", message: "This property was deleted." });
      try {
        socket.close(CLOSE_DELETED, "Property deleted");
      } catch {
        // Already gone.
      }
    }
    const property = this.meta.property;
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    this.createTables();
    this.meta = { ...freshMeta(), property, deleted: true };
    await this.saveMeta();
    log("property.deleted", { property: shortId(property), closed: sockets.length });
    return json({ ok: true });
  }

  /* flush */

  // One database write per burst of comments, not one per comment. The rows
  // are written first and deleted from the buffer after, so a failure in
  // between leaves duplicates for the next alarm (INSERT OR IGNORE on the
  // comment's own id), never a gap. A comment whose request was withdrawn or
  // deleted in the meantime is dropped by WHERE EXISTS. If this throws, the
  // runtime retries the alarm.
  async alarm() {
    const started = Date.now();
    const sql = this.ctx.storage.sql;
    const rows = sql.exec("SELECT * FROM pending ORDER BY at, id LIMIT ?", FLUSH_ROWS).toArray();
    if (!rows.length || !this.env.DB || !this.meta.property) return;
    const db = this.env.DB;
    const tickets = [...new Set(rows.map((r) => r.ticket_id))];
    try {
      await db.batch([
        ...rows.map((r) =>
          db
            .prepare(
              "INSERT OR IGNORE INTO ticket_events (id, ticket_id, property_id, kind, author_id, body, status, at)" +
                " SELECT ?1, ?2, ?3, 'comment', ?4, ?5, '', ?6 WHERE EXISTS (SELECT 1 FROM tickets WHERE id = ?2)",
            )
            .bind(r.id, r.ticket_id, this.meta.property, r.author_id, r.body, r.at),
        ),
        ...tickets.map((id) =>
          db
            .prepare(
              "UPDATE tickets SET comment_count = (SELECT COUNT(*) FROM ticket_events WHERE ticket_id = ?1 AND kind = 'comment')," +
                " updated_at = MAX(updated_at, (SELECT COALESCE(MAX(at), 0) FROM ticket_events WHERE ticket_id = ?1)) WHERE id = ?1",
            )
            .bind(id),
        ),
      ]);
    } catch (err) {
      log("flush.failed", { property: shortId(this.meta.property), rows: rows.length, error: err && err.name });
      throw err;
    }
    for (const r of rows) sql.exec("DELETE FROM pending WHERE id = ?", r.id);
    const left = sql.exec("SELECT COUNT(*) AS n FROM pending").one().n;
    if (left) await this.ctx.storage.setAlarm(Date.now() + 250);
    log("flush", {
      property: shortId(this.meta.property),
      rows: rows.length,
      tickets: tickets.length,
      left,
      ms: Date.now() - started,
    });
  }

  /* storage */

  async remember(propertyId) {
    if (isId(propertyId) && this.meta.property !== propertyId) {
      this.meta.property = propertyId;
      await this.saveMeta();
    }
  }

  saveMeta() {
    return this.ctx.storage.put("meta", this.meta);
  }

  // Everyone on the given leases plus the landlord, or everyone at all. A
  // Set, so someone on two leases gets each event once.
  sendTo(event, to, except) {
    const targets = new Set(this.ctx.getWebSockets(LANDLORD));
    if (to === "all") {
      for (const socket of this.ctx.getWebSockets()) targets.add(socket);
    } else {
      for (const id of to || []) for (const socket of this.ctx.getWebSockets("lease:" + id)) targets.add(socket);
    }
    const data = JSON.stringify(event);
    let sent = 0;
    for (const socket of targets) {
      if (socket === except) continue;
      try {
        socket.send(data);
        sent += 1;
      } catch {
        // A socket mid-close is dropped by the runtime; nothing to do here.
      }
    }
    return sent;
  }
}

function freshMeta() {
  return { property: "", deleted: false };
}

function attachment(ws) {
  try {
    return ws.deserializeAttachment();
  } catch {
    return null;
  }
}

function send(ws, event) {
  try {
    ws.send(JSON.stringify(event));
  } catch {
    // Closed between the check and the send.
  }
}

/* ------------------------------------------------------------ validation */

function isId(value) {
  return typeof value === "string" && UUID.test(value);
}

// Collapses whitespace: names, titles, addresses, unit numbers.
function oneLine(value, max) {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, max);
}

// Keeps paragraphs, trims the rest: announcement and request bodies.
function multiLine(value, max) {
  if (typeof value !== "string") return "";
  return value
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, max);
}

// Whole cents only: the client does money in strings, never floats.
function cents(value) {
  return Number.isInteger(value) && value >= 0 && value <= MAX_CENTS ? value : null;
}

// "2026-10-01" to UTC midnight of that day, or null for anything that isn't
// a real date.
function dateOn(value) {
  const m = DATE_RE.exec(String(value || ""));
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const d = new Date(ms);
  if (d.getUTCMonth() !== Number(m[2]) - 1 || d.getUTCDate() !== Number(m[3])) return null;
  return ms;
}

function emailOf(value) {
  const email = oneLine(value, MAX.email).toLowerCase();
  return EMAIL_RE.test(email) ? email : null;
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value || "");
  } catch {
    return "";
  }
}

/* ----------------------------------------------------------------- utils */

// 18 random bytes, base64url: 24 characters nobody guesses.
function newToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// A confirmation code a person can read out loud: no 0/O or 1/I.
function newCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  let code = "KR-";
  for (const b of bytes) code += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return code;
}

async function readJSON(request) {
  try {
    const parsed = await request.json();
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function methodNotAllowed() {
  return fail(405, "method_not_allowed", "method not allowed");
}

function notFound(message = "not found") {
  return fail(404, "not_found", message);
}

function fail(status, code, error) {
  return json({ error, code }, status);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

function changed(result) {
  return (result && result.meta && result.meta.changes) || 0;
}

/* --------------------------------------------------------------- logging */
//
// Read these back with `yard service logs` (add --since 2h). Every line
// starts with [keyring] and is one event, so it greps cleanly:
//   yard service logs | grep 'pay.'
//
// Not logged: names, emails, addresses, unit numbers, titles, comment text,
// amounts, invite tokens. Ids are cut to 8 characters: enough to correlate
// lines within a session, not a lasting identifier sitting in a log store.

function log(event, fields) {
  const parts = ["[keyring] " + event];
  for (const key in fields) {
    const value = fields[key];
    if (value === undefined || value === null) continue;
    parts.push(key + "=" + value);
  }
  console.log(parts.join(" "));
}

function shortId(id) {
  return typeof id === "string" && id ? id.slice(0, 8) : "-";
}

// Ids shortened, invite tokens and receipt codes hidden. The query string is
// never passed in.
function redactPath(pathname) {
  const parts = pathname.split("/");
  return parts
    .map((segment, i) => {
      if (UUID.test(segment)) return shortId(segment);
      if ((parts[i - 1] === "invites" || parts[i - 1] === "receipts") && segment && !UUID.test(segment)) return "…";
      return segment;
    })
    .join("/");
}
