#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${1:-http://localhost:8080}"
AUTH="Authorization: Bearer testuser"
CT="Content-Type: application/json"
PASS='\033[0;32m✓ PASS\033[0m'
FAIL='\033[0;31m✗ FAIL\033[0m'

echo "============================================"
echo "  Wallet Service — Burst Test Suite"
echo "  Target: $BASE_URL"
echo "============================================"
echo ""

# ========================================
# GATE 1: Race-free get-or-create
# ========================================
echo "--- Gate 1: Concurrent get-or-create (50 requests) ---"
USER_ID="gate1_$(date +%s%N)"
TMPFILE=$(mktemp)

for i in $(seq 1 50); do
  curl -s -X POST "$BASE_URL/wallets" \
    -H "$AUTH" -H "$CT" \
    -d "{\"user_id\":\"$USER_ID\"}" >> "$TMPFILE" &
done
wait

UNIQUE_IDS=$(grep -oP '"id":"[^"]+"' "$TMPFILE" | sort -u | wc -l)
rm -f "$TMPFILE"

if [ "$UNIQUE_IDS" -eq 1 ]; then
  echo -e "$PASS 50 concurrent creates → exactly 1 wallet"
else
  echo -e "$FAIL 50 concurrent creates → $UNIQUE_IDS wallets (expected 1)"
  exit 1
fi
echo ""

# ========================================
# GATE 2: Idempotent retry storm
# ========================================
echo "--- Gate 2: Idempotent retry storm (30 requests, same key) ---"

SENDER_ID="sender_$(date +%s%N)"
RECEIVER_ID="receiver_$(date +%s%N)"

SENDER=$(curl -s -X POST "$BASE_URL/wallets" -H "$AUTH" -H "$CT" -d "{\"user_id\":\"$SENDER_ID\"}")
RECEIVER=$(curl -s -X POST "$BASE_URL/wallets" -H "$AUTH" -H "$CT" -d "{\"user_id\":\"$RECEIVER_ID\"}")

SWID=$(echo "$SENDER" | grep -oP '"id":"\K[^"]+' | head -1)
RWID=$(echo "$RECEIVER" | grep -oP '"id":"\K[^"]+' | head -1)

# Seed sender with funds
curl -s -X POST "$BASE_URL/wallets/$SWID/deposit" -H "$AUTH" -H "$CT" -d '{"amount_paise":100000}' > /dev/null

echo "Sender: $SWID (seeded 100000 paise) | Receiver: $RWID"

IDEM_KEY="idem_$(date +%s%N)"
TMPFILE=$(mktemp)

for i in $(seq 1 30); do
  curl -s -X POST "$BASE_URL/transfers" \
    -H "$AUTH" -H "$CT" \
    -d "{\"from\":\"$SWID\",\"to\":\"$RWID\",\"amount_paise\":500,\"idempotency_key\":\"$IDEM_KEY\"}" >> "$TMPFILE" &
done
wait

UNIQUE_RESP=$(sort -u "$TMPFILE" | wc -l)
rm -f "$TMPFILE"

if [ "$UNIQUE_RESP" -eq 1 ]; then
  echo -e "$PASS 30 concurrent same-key transfers → all identical responses"
else
  echo -e "$FAIL 30 concurrent same-key transfers → $UNIQUE_RESP distinct responses (expected 1)"
fi

# Verify only 1 debit happened
SENDER_BAL=$(curl -s "$BASE_URL/wallets/$SWID" -H "$AUTH" | grep -oP '"balance":\K-?[0-9]+')
RECEIVER_BAL=$(curl -s "$BASE_URL/wallets/$RWID" -H "$AUTH" | grep -oP '"balance":\K-?[0-9]+')
echo "  Sender balance: $SENDER_BAL (expected 99500), Receiver balance: $RECEIVER_BAL (expected 500)"

if [ "$SENDER_BAL" -eq 99500 ] && [ "$RECEIVER_BAL" -eq 500 ]; then
  echo -e "$PASS Exactly one debit/credit applied"
else
  echo -e "$FAIL Balances incorrect — double debit or missed debit"
fi

# Same key + different body → 409
CONFLICT=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE_URL/transfers" \
  -H "$AUTH" -H "$CT" \
  -d "{\"from\":\"$SWID\",\"to\":\"$RWID\",\"amount_paise\":999,\"idempotency_key\":\"$IDEM_KEY\"}")

if [ "$CONFLICT" -eq 409 ]; then
  echo -e "$PASS Same key + different body → 409 Conflict"
else
  echo -e "$FAIL Same key + different body → HTTP $CONFLICT (expected 409)"
fi
echo ""

# ========================================
# GATE 3: Conservation under contention
# ========================================
echo "--- Gate 3: Conservation under contention (200 concurrent transfers) ---"

WIDS=()
TOTAL_SEEDED=0
for i in $(seq 1 4); do
  U="conserve_${i}_$(date +%s%N)"
  R=$(curl -s -X POST "$BASE_URL/wallets" -H "$AUTH" -H "$CT" -d "{\"user_id\":\"$U\"}")
  W=$(echo "$R" | grep -oP '"id":"\K[^"]+' | head -1)
  # Seed each wallet with 50000 paise (₹500)
  curl -s -X POST "$BASE_URL/wallets/$W/deposit" -H "$AUTH" -H "$CT" -d '{"amount_paise":50000}' > /dev/null
  WIDS+=("$W")
  TOTAL_SEEDED=$((TOTAL_SEEDED + 50000))
done

echo "Created & seeded 4 wallets (50000 paise each), total: $TOTAL_SEEDED"
echo "Wallets: ${WIDS[*]}"

# Fire 200 concurrent transfers (including A→B and B→A simultaneously)
for i in $(seq 1 200); do
  FI=$((RANDOM % 4))
  TI=$(( (FI + 1 + RANDOM % 3) % 4 ))
  K="cons_${i}_$(date +%s%N)_${RANDOM}"
  AMT=$((RANDOM % 2000 + 100))
  curl -s -X POST "$BASE_URL/transfers" \
    -H "$AUTH" -H "$CT" \
    -d "{\"from\":\"${WIDS[$FI]}\",\"to\":\"${WIDS[$TI]}\",\"amount_paise\":$AMT,\"idempotency_key\":\"$K\"}" > /dev/null 2>&1 &
done
wait

# Check conservation
TOTAL=0
ALL_OK=true
for wid in "${WIDS[@]}"; do
  BAL=$(curl -s "$BASE_URL/wallets/$wid" -H "$AUTH" | grep -oP '"balance":\K-?[0-9]+')
  echo "  Wallet $wid: balance=$BAL"
  if [ "$BAL" -lt 0 ]; then
    ALL_OK=false
    echo -e "  $FAIL Negative balance!"
  fi
  TOTAL=$((TOTAL + BAL))
done

echo ""
if [ "$TOTAL" -eq "$TOTAL_SEEDED" ] && [ "$ALL_OK" = true ]; then
  echo -e "$PASS Total balance = $TOTAL (conserved from $TOTAL_SEEDED), all non-negative"
else
  echo -e "$FAIL Total=$TOTAL (expected $TOTAL_SEEDED), all_ok=$ALL_OK"
fi

echo ""
echo "============================================"
echo "  All burst tests complete!"
echo "============================================"
