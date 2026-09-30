#!/usr/bin/env bash
# Keyring API checks, run against a fresh local server:
#
#   yard dev --reset-db --reset-rooms      (in another terminal)
#   tests/api.sh
#
# Every request picks its person with the yard_dev_identity cookie, exactly
# as a browser would after the persona picker:
#   user:landlord  the landlord (active Landlord plan)
#   signed-in      a tenant (signed in, bought nothing)
#   trial          a roommate (also on a Landlord trial, which doesn't matter here)
#   member         the project owner, who has nothing to do with this property
#
# Needs curl and jq. Reads the local database through the yard dev control
# panel (loopback only) to check what landed where.
set -uo pipefail

BASE="${BASE:-http://localhost:9875/keyring}"
API="$BASE/app/api"
PANEL="${PANEL:-http://localhost:9875/__yard/dev/api}"
L="user:landlord"
T="signed-in"
R="trial"
O="member"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
pass=0
failed=0

# call <persona> <method> <path> [json]: sets STATUS and BODY.
call() {
  local persona=$1 method=$2 path=$3 data=${4:-'{}'}
  local args=(-s -o "$TMP/body" -w '%{http_code}' -X "$method" -H "Cookie: yard_dev_identity=$persona" -H 'Accept: application/json')
  if [ "$method" != GET ]; then args+=(-H 'Content-Type: application/json' --data "$data"); fi
  STATUS=$(curl "${args[@]}" "$API/$path")
  BODY=$(cat "$TMP/body")
}

# expect <label> <status> [jq filter that must hold on BODY]
expect() {
  local label=$1 want=$2 filter=${3:-}
  if [ "$STATUS" = "$want" ] && { [ -z "$filter" ] || jq -e "$filter" <<<"$BODY" >/dev/null 2>&1; }; then
    pass=$((pass + 1))
    printf '  ok    %s\n' "$label"
  else
    failed=$((failed + 1))
    printf '  FAIL  %s (got %s: %s)\n' "$label" "$STATUS" "$(head -c 300 <<<"$BODY")"
  fi
}

# check <label> <actual> <expected>
check() {
  if [ "$2" = "$3" ]; then
    pass=$((pass + 1))
    printf '  ok    %s\n' "$1"
  else
    failed=$((failed + 1))
    printf '  FAIL  %s (got %s, want %s)\n' "$1" "$2" "$3"
  fi
}

# sql <query>: the first column of the first row, from the local database.
sql() {
  curl -s -X POST -H 'Content-Type: application/json' "$PANEL/db/query" \
    --data "$(jq -nc --arg s "$1" '{sql: $s, params: []}')" | jq -r '.rows[0][0]'
}

# Every table except users (whose seen_at every request refreshes).
counts() {
  sql "SELECT (SELECT COUNT(*) FROM properties)||','||(SELECT COUNT(*) FROM units)||','||(SELECT COUNT(*) FROM leases)||','||
    (SELECT COUNT(*) FROM rent_steps)||','||(SELECT COUNT(*) FROM lease_tenants)||','||(SELECT COUNT(*) FROM invites)||','||
    (SELECT COUNT(*) FROM charges)||','||(SELECT COUNT(*) FROM payments)||','||(SELECT COUNT(*) FROM announcements)||','||
    (SELECT COUNT(*) FROM tickets)||','||(SELECT COUNT(*) FROM ticket_events)"
}

MONTH=$(date -u +%Y-%m)
FIRST="$MONTH-01"
NEXT_MONTH=$(date -u -d "$FIRST +1 month" +%Y-%m)

echo "gate and plan"
code=$(curl -s -o /dev/null -w '%{http_code}' "$API/me")
check "anonymous is sent to sign in" "$code" "302"
call "$T" POST properties '{"name":"Nope"}'
expect "a tenant can't create a property" 403 '.code == "plan_required"'
call "$L" GET me
expect "the landlord has the plan" 200 '.landlord_plan == true'

echo "properties and units"
call "$L" POST properties '{"name":"Maple Court","address":"12 Maple Ave","phone":"555-0100","emergency":"555-0199","hours":"Mon-Fri 9-5"}'
expect "landlord creates a property" 201 '.role == "landlord" and .can_write == true'
PID=$(jq -r .id <<<"$BODY")
call "$L" POST "properties/$PID/units" '{"numbers":["1A","1B","1C"]}'
expect "adds three units" 201 '.created == 3'
call "$L" POST "properties/$PID/units" '{"numbers":["1a","1B"]}'
expect "numbers are unique, case-insensitively" 201 '.created == 0 and .skipped == 2'
call "$L" GET "properties/$PID/rentroll"
expect "rent roll lists the units, all vacant" 200 '.stats.units == 3 and .stats.occupied == 0'
U1=$(jq -r '.units[] | select(.number == "1A") | .unit_id' <<<"$BODY")
U2=$(jq -r '.units[] | select(.number == "1B") | .unit_id' <<<"$BODY")

echo "leases and invites"
call "$L" POST "units/$U1/leases" "{\"rent_cents\":185000,\"due_day\":1,\"starts_on\":\"$FIRST\",\"emails\":[\"signed-in@example.com\",\"trial@example.com\"]}"
expect "starts a lease with two invites" 201 '.invites | length == 2'
LID=$(jq -r .lease_id <<<"$BODY")
TOK1=$(jq -r '.invites[0].token' <<<"$BODY")
TOK2=$(jq -r '.invites[1].token' <<<"$BODY")
call "$L" POST "units/$U1/leases" "{\"rent_cents\":1,\"due_day\":1,\"starts_on\":\"$FIRST\"}"
expect "one running lease per unit" 409 '.code == "unit_occupied"'
call "$T" GET "invites/$TOK1"
expect "invite preview names the unit and matches the email label" 200 '.unit_number == "1A" and .sent_to_you == true and .rent_cents == 185000'
call "$O" GET "invites/$TOK1"
expect "someone else sees it wasn't sent to them" 200 '.sent_to_you == false'
call "$L" GET "invites/$TOK1"
expect "the landlord previewing their own link" 200 '.is_landlord == true'
call "$L" POST "invites/$TOK1/claim"
expect "the landlord can't claim their own link, and it isn't used up" 400 '.code == "invite_own_property"'

# Race: two people claim one link at the same moment; exactly one wins.
call "$L" POST "units/$U2/leases" "{\"rent_cents\":120000,\"due_day\":5,\"starts_on\":\"$FIRST\",\"emails\":[\"someone@example.com\"]}"
LID2=$(jq -r .lease_id <<<"$BODY")
TOKB=$(jq -r '.invites[0].token' <<<"$BODY")
for p in "$O" "$R"; do
  curl -s -o "$TMP/race-$p" -w '%{http_code}\n' -X POST -H "Cookie: yard_dev_identity=$p" -H 'Content-Type: application/json' \
    --data '{}' "$API/invites/$TOKB/claim" >"$TMP/race-status-$p" &
done
wait
wins=$(cat "$TMP"/race-status-* | grep -c '^201$')
check "a link claimed twice at once has exactly one winner" "$wins" "1"
check "and exactly one tenant row" "$(sql "SELECT COUNT(*) FROM lease_tenants WHERE lease_id = '$LID2'")" "1"
call "$L" POST "leases/$LID2/end"
expect "ending that lease" 200 '.ok == true'
call "$O" GET "leases/$LID2"
expect "former tenants lose the lease" 404
call "$R" GET "leases/$LID2"
expect "(either of them)" 404

call "$T" POST "invites/$TOK1/claim"
expect "tenant claims their invite" 201 ".lease_id == \"$LID\""
call "$T" POST "invites/$TOK1/claim"
expect "claiming again is harmless" 200 '.already_tenant == true'
call "$O" POST "invites/$TOK1/claim"
expect "a used link can't be reused" 409 '.code == "invite_claimed"'
call "$R" POST "invites/$TOK2/claim"
expect "roommate claims the second invite" 201
call "$L" POST "leases/$LID/invites" '{"email":"x@example.com"}'
TOK3=$(jq -r .token <<<"$BODY")
IID3=$(jq -r .id <<<"$BODY")
call "$L" DELETE "leases/$LID/invites/$IID3"
expect "landlord revokes an invite" 200
call "$O" GET "invites/$TOK3"
expect "a revoked link is invalid" 404 '.code == "invite_invalid"'

echo "who sees what"
call "$O" GET "properties/$PID"
expect "an outsider gets 404 for the property" 404
call "$O" GET "leases/$LID"
expect "... and for the lease" 404
call "$O" GET "properties/$PID/ws"
expect "... and for the socket" 404
call "$T" GET "properties/$PID"
expect "a tenant sees the property as a tenant" 200 '.role == "tenant" and .can_write == false'
call "$T" GET "properties/$PID/rentroll"
expect "a tenant can't read the rent roll" 403 '.code == "landlord_only"'
call "$T" GET "units/$U1"
expect "units are landlord-only" 404
call "$T" PATCH "properties/$PID" '{"name":"Mine now"}'
expect "a tenant can't edit the property" 403 '.code == "landlord_only"'
call "$T" POST "leases/$LID/charges" '{"kind":"other","amount_cents":1}'
expect "a tenant can't add charges" 403 '.code == "landlord_only"'
call "$T" GET "leases/$LID"
expect "tenant ledger: this month's rent, roommates by name, no emails, no invites" 200 \
  "(.items | map(.ref) | index(\"rent:$MONTH\")) != null and (.tenants | length == 2) and (.tenants | all(.email == null)) and (.invites | length == 0)"

echo "charges and payments"
call "$L" POST "leases/$LID/charges" '{"kind":"late_fee","amount_cents":5000}'
expect "landlord adds a late fee" 201
CID1=$(jq -r .id <<<"$BODY")
call "$L" POST "leases/$LID/charges" '{"kind":"utilities","label":"Water, September","amount_cents":4200}'
CID2=$(jq -r .id <<<"$BODY")
call "$T" POST "leases/$LID/payments" "{\"refs\":[\"rent:$MONTH\"],\"expected_cents\":185000,\"method\":\"card\",\"card\":\"tok_chargeDeclined\"}"
expect "a declined test card is refused" 402 '.code == "card_declined"'
check "... and writes nothing" "$(sql 'SELECT COUNT(*) FROM payments')" "0"
call "$T" POST "leases/$LID/payments" "{\"refs\":[\"rent:$MONTH\"],\"expected_cents\":100,\"method\":\"card\",\"card\":\"tok_visa\"}"
expect "a stale total is refused" 409 '.code == "amount_changed"'
call "$T" POST "leases/$LID/payments" '{"refs":["rent:1999-01"],"expected_cents":0,"method":"card","card":"tok_visa"}'
expect "an item that isn't on the bill is refused" 409 '.code == "items_changed"'
call "$T" POST "leases/$LID/payments" "{\"refs\":[\"rent:$MONTH\"],\"expected_cents\":185000,\"method\":\"cash\"}"
expect "tenants pay by card only" 400 '.code == "bad_method"'

# Race: both roommates pay the same rent at the same moment.
for p in "$T" "$R"; do
  curl -s -o "$TMP/pay-$p" -w '%{http_code}\n' -X POST -H "Cookie: yard_dev_identity=$p" -H 'Content-Type: application/json' \
    --data "{\"refs\":[\"rent:$MONTH\"],\"expected_cents\":185000,\"method\":\"card\",\"card\":\"tok_visa\"}" \
    "$API/leases/$LID/payments" >"$TMP/pay-status-$p" &
done
wait
paid=$(cat "$TMP"/pay-status-* | grep -c '^201$')
check "rent paid twice at once is paid once" "$paid" "1"
check "... with exactly one payment row" "$(sql "SELECT COUNT(*) FROM payments WHERE item_ref = 'rent:$MONTH'")" "1"

call "$L" DELETE "leases/$LID/charges/$CID1"
expect "landlord voids an unpaid charge" 200
call "$T" POST "leases/$LID/payments" '{"refs":["charge:'"$CID2"'"],"expected_cents":4200,"method":"card","card":"tok_visa"}'
expect "tenant pays the water bill" 201 '.paid | length == 1'
CODE=$(jq -r .confirmation <<<"$BODY")
call "$L" DELETE "leases/$LID/charges/$CID2"
expect "a paid charge can't be voided" 409 '.code == "charge_paid"'
call "$R" GET "leases/$LID/receipts/$CODE"
expect "the roommate can open the receipt" 200 '.total_cents == 4200 and .lines[0].label == "Water, September"'
call "$L" POST "leases/$LID/charges" '{"kind":"deposit","amount_cents":185000}'
DEP=$(jq -r .id <<<"$BODY")
call "$L" POST "leases/$LID/payments" '{"refs":["charge:'"$DEP"'"],"expected_cents":185000,"method":"check"}'
expect "landlord records a check" 201
call "$T" GET "leases/$LID"
expect "the ledger shows everything paid" 200 '.balance_cents == 0 and (.items | all(.status == "paid"))'
call "$L" GET "properties/$PID/rentroll"
expect "the rent roll counts this month's collections" 200 '.stats.collected_month_cents == 374200 and .stats.occupied == 1'

echo "rent changes"
call "$L" PATCH "leases/$LID" "{\"rent_cents\":190000,\"from_month\":\"$MONTH\"}"
expect "rent can't change for this month" 400 '.code == "bad_month"'
call "$L" PATCH "leases/$LID" "{\"rent_cents\":190000,\"from_month\":\"$NEXT_MONTH\"}"
expect "rent changes from next month" 200 ".next_rent.amount_cents == 190000 and (.items[] | select(.ref == \"rent:$MONTH\") | .amount_cents) == 185000"

echo "announcements"
call "$L" POST "properties/$PID/announcements" '{"title":"Water off Friday","body":"From 9 to noon.\n\nSorry!","pinned":true}'
expect "landlord posts a pinned announcement" 201
AID=$(jq -r .id <<<"$BODY")
call "$T" GET "properties/$PID/announcements"
expect "tenants read it" 200 '.[0].title == "Water off Friday" and .[0].pinned == true'
call "$T" POST "properties/$PID/announcements" '{"title":"Party"}'
expect "tenants can't post" 403 '.code == "landlord_only"'
call "$L" PATCH "properties/$PID/announcements/$AID" '{"pinned":false}'
expect "landlord unpins it" 200 '.pinned == false'

echo "requests"
call "$T" POST "leases/$LID/tickets" '{"category":"plumbing","title":"Kitchen sink drips","body":"Since Monday.","entry_ok":true}'
expect "tenant files a request" 201
TID=$(jq -r .id <<<"$BODY")
call "$L" POST "leases/$LID/tickets" '{"category":"plumbing","title":"x"}'
expect "requests come from tenants" 403 '.code == "tenants_only"'
call "$L" GET "properties/$PID/tickets?status=open"
expect "landlord sees it" 200 ".[0].id == \"$TID\" and .[0].unit_number == \"1A\""
call "$R" GET "tickets/$TID"
expect "the roommate sees it" 200 '.can_withdraw == false'
call "$O" GET "tickets/$TID"
expect "an outsider doesn't" 404
call "$T" PATCH "tickets/$TID" '{"status":"resolved"}'
expect "tenants can't change the status" 403
call "$L" PATCH "tickets/$TID" '{"status":"acknowledged"}'
expect "landlord acknowledges" 200
call "$T" DELETE "tickets/$TID"
expect "an acknowledged request can't be withdrawn" 409 '.code == "ticket_locked"'
call "$T" POST "leases/$LID/tickets" '{"category":"pest","title":"Saw a mouse"}'
TID2=$(jq -r .id <<<"$BODY")
call "$R" DELETE "tickets/$TID2"
expect "only its author can withdraw it" 403 '.code == "not_yours"'
call "$T" DELETE "tickets/$TID2"
expect "the author withdraws a submitted request" 200

echo "comments are buffered, then flushed once"
for i in 1 2 3 4; do call "$T" POST "tickets/$TID/comments" "{\"body\":\"note $i\"}"; done
call "$L" POST "tickets/$TID/comments" '{"body":"On it tomorrow."}'
expect "landlord comments" 201 '.role == "landlord"'
check "nothing is in the database yet" "$(sql "SELECT COUNT(*) FROM ticket_events WHERE kind = 'comment'")" "0"
call "$R" GET "tickets/$TID"
expect "the thread already shows all five" 200 '[.events[] | select(.kind == "comment")] | length == 5'
sleep 7
check "after the alarm, all five are in the database" "$(sql "SELECT COUNT(*) FROM ticket_events WHERE kind = 'comment'")" "5"
check "... and the request's count is updated" "$(sql "SELECT comment_count FROM tickets WHERE id = '$TID'")" "5"
call "$T" GET "tickets/$TID"
expect "the thread still shows five, once each" 200 '[.events[] | select(.kind == "comment")] | length == 5'

echo "reads never write"
before=$(counts)
for p in "$L" "$T" "$R" "$O"; do
  for path in me properties "properties/$PID" "properties/$PID/rentroll" "properties/$PID/announcements" \
    "properties/$PID/tickets" "units/$U1" "leases/$LID" "leases/$LID/receipts/$CODE" "tickets/$TID" "invites/$TOK1"; do
    call "$p" GET "$path"
  done
done
check "row counts are unchanged after every GET as every persona" "$(counts)" "$before"

echo "a lapsed landlord is read-only"
call "$R" POST properties '{"name":"Trial Towers"}'
expect "a trial landlord can create a property" 201
P2=$(jq -r .id <<<"$BODY")
sql "UPDATE properties SET landlord_id = 'dev-persona-signed-in' WHERE id = '$P2'" >/dev/null
call "$T" GET "properties/$P2"
expect "a landlord without the plan still reads" 200 '.role == "landlord" and .can_write == false'
call "$T" POST "properties/$P2/units" '{"numbers":["1"]}'
expect "... but can't write" 403 '.code == "plan_required"'

echo "removal"
call "$L" DELETE "leases/$LID/tenants/dev-persona-trial"
expect "landlord removes the roommate" 200
call "$R" GET "leases/$LID"
expect "the roommate has lost the lease" 404
call "$R" GET "properties/$PID"
expect "... and the property" 404
call "$L" DELETE "properties/$PID" '{"confirm_name":"Maple"}'
expect "deleting needs the exact name" 400 '.code == "confirm_mismatch"'
call "$L" DELETE "properties/$PID" '{"confirm_name":"maple court"}'
expect "landlord deletes the property" 200
call "$T" GET "properties/$PID"
expect "the tenant has lost it" 404
check "every row went with it" "$(sql "SELECT COUNT(*) FROM leases WHERE property_id = '$PID'")" "0"

echo
echo "$pass passed, $failed failed"
[ "$failed" -eq 0 ]
