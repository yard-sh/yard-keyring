# Keyring

<p align="center">
<a href="https://dash.yard.sh/projects?action=create&repo=https%3A%2F%2Fgithub.com%2Fyard-sh%2Fyard-keyring"><img src="https://yard.sh/create-in-yard.png" width="200" alt="Create in Yard" /></a>
</p>

A landlord and tenant portal hosted end to end on Yard. Landlords add their
buildings and units, start leases, and invite tenants with a link. Tenants
see their unit, pay what's due and ask for repairs. Both sides watch it
happen live: a payment lands on the rent roll the moment it's made, and a
request's status changes on the tenant's screen the moment the landlord
moves it. The pieces:

- **Frontend:** a static app in plain ES modules, with no build step.
- **Backend:** one fetch handler, plus one realtime room per property.
- **Storage:** a per-project SQLite database.
- **Sign-in:** Yard Auth.
- **Pricing:** one Landlord tier at $50 a month, with a 14-day trial that
  needs no card. Tenants never pay.

**It's a demo.** Rent paid inside Keyring is simulated with test cards: no
payment provider is involved and no money moves. The app and the landing page
say so wherever money appears. The Landlord plan is different: it is a real
Yard subscription for whoever runs a copy of Keyring.

Use the button above, or paste this repository's URL into the **Create from
GitHub URL** field of the Yard dashboard's Create Project dialog. Keyring
declares rooms (realtime state inside a service) and a custom landing page.
Rooms are part of Yard Basic and Pro, so creating it needs one of those plans.
The service is `authenticated`, so it also needs Yard Auth, and the Landlord
tier is a subscription with a free trial, which the team's plan must allow.

Once it's live:

- The landing page is at `https://<team>.yard.sh/<slug>/`.
- The app is at `https://<team>.yard.sh/<slug>/app/`.

## Layout

    .yard/
      settings.json       every project setting: service, room class, landing page, pricing
      migrations/         properties, units, leases, invites, charges, payments, requests, announcements
      landing-page/       the public page, with a keyring you can jingle and pricing built from the tiers
      dev/                local state written by yard dev; ignored by git
    app/                  the deployable bundle (the services[] entry with dir: app)
      _service.js         the whole backend: the fetch handler and the Property room class
      index.html          app shell: top bar, demo strip, icon sprite
      app.js              boot, routing, portal switch, account menu, invite links, the live connection
      landlord.js         portfolio, rent roll, one unit (lease, people, ledger), property settings
      tenant.js           the tenant's home and payments
      tickets.js          maintenance requests and their live threads, for both portals
      notices.js          announcements, for both portals
      pay.js              the simulated checkout and receipts
      live.js             the socket client: reconnects, close codes, typing
      api.js · ui.js      fetch wrapper; DOM helpers, dialogs, money and dates
      styles.css          navy & sky tokens, light and dark
    tests/                curl and Playwright checks against yard dev; not deployed

The service entry declares its mount, access mode, database, and room class:

    "services": [
      { "dir": "app", "name": "app", "url": "/app",
        "access": "authenticated", "database_access": true,
        "rooms": [{ "class": "Property", "binding": "PROPERTIES" }] }
    ]

## How it fits together

**One property is one room.** `_service.js` exports a class called
`Property`.

- Yard keeps one instance of it per property, reached through `env.PROPERTIES`.
- The landlord and every tenant with that property open are connected to that
  same instance, and it relays what happens there to the people it concerns.
- The room's socket tags make that routing a lookup, not a loop: the
  landlord's sockets carry `landlord` and a tenant's carry `lease:<id>`, so a
  payment on one lease reaches that lease's roommates and the landlord and
  nobody else in the building. Announcements go to everyone.

**The handler decides who gets in.** Every request reads membership from the
database: a property's landlord is `properties.landlord_id`, and its tenants
are the people on a running lease there. Anything you're not part of answers
404, the same as something that doesn't exist, so ids can't be probed. The
socket route, `GET api/properties/:id/ws`, does the same check, strips any
client-sent `X-Keyring-*` headers, stamps trusted ones (role, leases, name)
and forwards the upgrade. The room trusts `X-Keyring-*` the way it trusts
`X-Yard-*`. The edge honors the session only for requests from the project's
own pages, so a socket opened from any other site arrives signed out and is
turned away.

**The server is the paywall.** A landlord *write* needs the property to be
theirs and the Landlord plan to be live: the project owner, or an `active` or
`trial` entitlement on the Landlord tier. Reads never check the plan. So when
a trial ends unconverted (it needs no card, so many will), the landlord keeps
everything, read-only, and their tenants notice nothing. The tier name is the
`LANDLORD_TIER` constant; rename it together with `settings.json`. The app
re-reads `api/me` when the window regains focus, because the edge caches
entitlement for up to a minute and pushes nothing.

**Rent is computed, never stored.** A lease has a due day (1 to 28), a start
date, an optional last day, and its rent in `rent_steps`. Every time a ledger
is read, the handler works out the rent items from those terms, so nothing
has to run on the 1st and no GET ever writes.

- Rent for a month appears on the 1st of that month, starting with the first
  due date on or after the lease start. A lease that starts on the 15th with
  rent due on the 1st owes its first rent on the 1st of the next month; a
  partial month is a one-off charge.
- An unpaid item is overdue once its due day is over.
- A rent change always starts in a future month, so an amount a tenant has
  already seen never changes under them.
- Months and due dates are UTC, and the app shows every calendar date in UTC,
  so a due date never slips to the day before in the Americas.

One-off charges (deposit, late fee, utilities, anything else) are rows, and
the landlord can void them while they're unpaid.

**A payment can't land twice.** Each paid item is one row with
`UNIQUE(lease_id, item_ref)`, where `item_ref` is `rent:2026-10` or
`charge:<id>`. Paying is one `INSERT OR IGNORE` per item, so two roommates
pressing Pay at the same moment get one row between them, and voiding is one
conditional `DELETE`, so whichever of pay and void runs first wins. The
client sends the items and the total it showed, and both are checked against
a fresh ledger. A payment copies its label and amount, so a receipt never
changes.

The checkout never sends a card number. `pay.js` maps the two test cards to
tokens (4242 4242 4242 4242 approves, 4000 0000 0000 0002 declines), refuses
anything else before a request is made, and sends only the token. Landlords
can also record cash and checks.

**An invite link works once.** The landlord starts a lease on a vacant unit
and lists the tenants' emails; each email gets its own link,
`…/app/?invite=<token>`, good for 14 days. The email is only a label (the
preview gently warns when it doesn't match the account opening the link), and
whoever signs in with the link first claims it. Claiming is two conditional
statements: an `UPDATE` that takes the link only if nobody has, then an
`INSERT` that adds the claimer only if they won and the lease has room (six
tenants, counting unclaimed links). Each is atomic on its own, so this holds
whether or not a batch is a transaction. A landlord opening their own link, or
a tenant opening it twice, doesn't use it up.

**Comments are written once per burst.** Replies on a request go to
`POST api/tickets/:id/comments`, where the handler checks access and the
landlord's plan against the database. It hands the comment to the property's
room, which:

- stores it in its own SQL buffer,
- relays it to the landlord and that lease at once,
- arms an alarm if none is set.

Five seconds later, `alarm()` writes everything buffered to `ticket_events` in
one batch (`INSERT OR IGNORE` on the comment's own id, so a retried flush
writes nothing twice) and only then deletes those rows from the buffer.
Reading a thread asks the room for its buffer first and the database second,
and merges by id: a comment that has left the buffer by the time it's asked is
already in the database when that's read. Typing indicators are the only
frames a client sends over the socket; they are relayed, throttled to one
every 2.5 seconds, and never stored.

**Events are hints.** Apart from comments and typing, a socket event says what
changed (`ledger.changed`, `ticket.updated`, `announcement.posted`,
`lease.changed`…) and the view re-fetches what it shows. A view repaints only
when the data actually changed, and a form or a half-written reply is never
repainted. Every connection starts with `hello`, and the view re-fetches then
too, which is how a tab catches up after any reconnect.

**Losing access takes effect now.** Removing a tenant or ending a lease asks
the property's room to close that person's sockets:

    4003  removed: no lease left in this property     the client stops and says so
    4004  access changed: another lease still here    the client reconnects
    4002  property deleted (a tombstone stays)        the client stops and says so
    1000  "Session limit reached"                     Yard's 24-hour cap; reconnect at once

Any other close backs off from half a second to eight, and asks
`GET api/properties/:id` before reconnecting, since a refused upgrade reaches
the browser with no reason attached: a 404 means access is gone.

**Two portals, one app.** The landlord portal lives under `#/l` and the
tenant portal under `#/t/<lease>`, with their own headers and tabs. Someone
who is both (a landlord renting a flat elsewhere) gets a switch in the top
bar. The landing page's Landlord login and Tenant login buttons also store
which portal was asked for, because a first sign-in's consent screen may not
hand the `#hash` back.

Two details worth knowing before editing:

- **Relative URLs only.** The app is mounted at `/<slug>/app/`, so it uses
  `fetch("api/me")`, never `/api/me`. Routes live in `location.hash`, and the
  socket URL is built from `location.href`.
- **The class name is the identity.** Renaming `Property` in `settings.json`
  deletes every property room on the next deploy, with any comments still
  in its buffer; `yard push` warns before it does. Change the `binding` if
  only the name in `env` should change.

## Local development

    yard dev

This serves the landing page at `http://localhost:9875/keyring/` and the app
at `http://localhost:9875/keyring/app/`. The migration is applied to a local
database, and property rooms are stored under `.yard/dev/rooms/`.

There is no sign-up screen and no login code in this repo: Yard Auth signs
people in and hands the service trusted `X-Yard-*` headers. Locally, a
**persona** stands in for it, and each persona is a different person:

| Persona         | Who they are                                                   |
| --------------- | -------------------------------------------------------------- |
| `user:landlord` | a landlord on the paid Landlord plan                           |
| `trial`         | a landlord on the free trial (also handy as a second tenant)   |
| `signed-in`     | a tenant: signed in, bought nothing                            |
| `member`        | you, the project owner, with landlord tools included           |

- **Switching:** switch at `http://localhost:9875/keyring/app/__yard/auth/login`,
  or start with `yard dev --as user:landlord`.
- **Trying both sides:** open the app as `user:landlord`, start a lease with
  `signed-in@example.com` as the tenant, copy the invite link, and open it in
  a private window as `signed-in`. Pay the rent there and watch the rent roll.
- **A lapsed plan:** there is no persona for a landlord whose plan ended, so
  `tests/api.sh` makes one by handing a property to `signed-in` through the
  local database. That landlord reads everything, and every write answers
  `plan_required`.

Every save restarts the local runtime, which drops every open socket. The
client reconnects on its own, the same way it does when a hosted session
reaches its 24-hour limit. `yard dev --reset-db` starts from an empty database
and `--reset-rooms` deletes every stored room.

## Testing

Both suites run against a local server:

    yard dev --reset-db --reset-rooms        # in another terminal
    tests/api.sh                             # curl + jq, 81 checks
    cd tests && npm ci && npx playwright test

- **`tests/api.sh`** drives the API as four personas: 404s for outsiders,
  refusals for tenants, plan gating, an invite claimed twice at once, rent paid
  twice at once, voiding, rent changes, the comment buffer and its single
  flush, a lapsed landlord, removal and deletion, and that no GET changes a
  row.
- **`tests/e2e.spec.mjs`** tells the same story in four browser contexts with
  Playwright: pricing from the tiers, joining by link, live updates in both
  directions, typing, the simulated checkout, reloads before and after a
  flush, and a tenant's open page closing when they lose access.

The Playwright config starts `yard dev` itself if nothing is listening, and
empties the local database and rooms before every run.

## Logging

    yard service logs --since 2h
    yard service logs --since 2h | grep 'pay.'

Every line starts with `[keyring]` and is one event:

    [keyring] ws.forward property=ac97bcc9 user=05c444a7 role=landlord
    [keyring] peer.join property=ac97bcc9 cid=0981ba30 user=05c444a7 role=landlord peers=1
    [keyring] invite.claim invite=d78218ef lease=1cb2febd user=5b1c37d7
    [keyring] pay.card lease=bdc030bb items=1 skipped=0
    [keyring] flush property=e53ed2e2 rows=5 tickets=1 left=0 ms=6

**Handler events:**

- `request`, `auth.rejected`, `plan.required`, `me.rename`
- `property.create|update|delete`, `unit.create|rename|delete`
- `lease.create|update|end`, `tenant.remove`
- `invite.create|revoke|claim`, `invite.claim.rejected`
- `charge.create|void`, `pay.card|recorded|declined|conflict`
- `announcement.post|update|delete`
- `ticket.create|status|withdraw`, `comment.post`
- `ws.forward`

**Room events:**

- `property.wake|full|tombstone|deleted`
- `peer.join|leave|error`, `frame.rejected`, `typing.rejected`
- `relay`, `kick`
- `comment.buffer|busy`, `flush`, `flush.failed`

Failures go to `console.error` as `request.failed` and `internal.failed`.

**Not logged:** names, emails, addresses, unit numbers, titles, comment text,
amounts, invite tokens. Ids are cut to 8 characters, including inside request
paths.

## Usage and cost

Rooms are metered: requests, compute time while something is handled, and
stored bytes. A property that holds sockets but sees no activity costs no
compute. What costs a room request:

- every write someone else should see (a payment, a charge, a request, a
  status change, an announcement, a claimed invite): one relay each,
- every comment (the room buffers it), and every thread opened (the
  handler reads the buffer),
- each socket connection.

Typing frames are throttled to one every 2.5 seconds, and an inbound socket
message counts as one twentieth of a request. The database gets one write per
burst of comments, not one per comment. The Usage page in the dashboard shows
the month so far.

## Shipping

    yard service check                        validate bundle + lint, no network
    yard push                                 upload service, page and settings into the draft
    yard releases publish <tag>               publish the draft, which makes it live
    yard service open                         print/open the live app URL
    yard db query "select name, created_at from properties"

Nothing serves a draft release, so pushing is safe to repeat. Migrations
apply themselves at deploy. To try a release before anyone else sees it:

    yard sandbox create preview
    yard sandbox pin                            hold the project on what it serves
    yard releases publish <tag>
    yard sandbox pin <tag> --sandbox preview
    yard service open --sandbox preview         team-only URL
    yard sandbox unpin                          go live

A sandbox has its own database, its own property rooms and its own
simulated commerce, so the Landlord trial and checkout can be tried there end
to end without money moving.

## Data lifecycle

- **Deleting a property** needs its name typed. It removes every row of the
  property in one batch, then tells its room to close every socket, drop its
  storage and keep a small tombstone, so a connection already on its way can't
  reopen it.
- **Deleting a unit** is possible only while it's vacant, and takes its past
  leases and their ledgers with it.
- **Ending a lease** keeps its ledger for the landlord. Its tenants lose
  access, and its unused invite links are deleted.
- **Removing a tenant** keeps the lease and its ledger as they are.
- **Withdrawing a request** deletes it and its thread; a comment still in the
  room's buffer for it is dropped at the next flush.
- **Removing the `Property` class** from `settings.json` deletes every
  property room at the next deploy, including comments not yet flushed.
- **Removing the whole service** keeps room data for 30 days.
