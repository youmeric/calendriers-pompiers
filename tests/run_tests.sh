#!/bin/sh
# Lance tous les tests : API (Python) puis navigateur (Playwright), sur une commune de test synthétique.
#   sh tests/run_tests.sh            tout
#   sh tests/run_tests.sh api        seulement les tests API
#   sh tests/run_tests.sh ui_correction   un seul test
# Prérequis : pip install -r backend/requirements.txt httpx ; npm install -g playwright (pour les tests navigateur).
# Les tests n'utilisent jamais la vraie base : tout se passe dans un dossier temporaire.
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(dirname "$HERE")
export TEST_DIR="${TEST_DIR:-$(mktemp -d -t calendriers-tests-XXXXXX)}"
PORT="${TEST_PORT:-8123}"
export TEST_URL="http://127.0.0.1:$PORT"
python3 "$HERE/fake_data.py" "$TEST_DIR/sectors" || exit 1
WANT="${1:-all}"
FAILED=""

for t in "$HERE"/api_*_test.py; do
  name=$(basename "$t" .py)
  case "$WANT" in all|api|"$name") ;; *) continue ;; esac
  echo "== $name"
  if ! python3 "$t" > "$TEST_DIR/$name.log" 2>&1; then FAILED="$FAILED $name"; fi
  grep -E "^FAIL|ÉCHECS|Error" "$TEST_DIR/$name.log"
done

[ "$WANT" = "api" ] || for t in "$HERE"/ui_*.js; do
  name=$(basename "$t" .js)
  case "$WANT" in all|ui|"$name") ;; *) continue ;; esac
  # serveur neuf (base vide) pour chaque test navigateur
  rm -f "$TEST_DIR/ui.db"
  (cd "$ROOT" && DB_PATH="$TEST_DIR/ui.db" SECTORS_DATA_DIR="$TEST_DIR/sectors" ADMIN_PASSWORD=secret123 AUTO_BACKUP=0 \
    python3 -m uvicorn backend.app.main:app --host 127.0.0.1 --port "$PORT" > "$TEST_DIR/uvicorn.log" 2>&1) &
  SERVER=$!
  i=0; until curl -s -o /dev/null "$TEST_URL/api/communes" || [ $i -ge 50 ]; do sleep 0.2; i=$((i + 1)); done
  echo "== $name"
  if ! NODE_PATH="$(npm root -g)" node "$t" > "$TEST_DIR/$name.log" 2>&1; then FAILED="$FAILED $name"; fi
  grep -v "^OK" "$TEST_DIR/$name.log"
  kill $SERVER 2>/dev/null; pkill -f "uvicorn backend.app.main:app --host 127.0.0.1 --port $PORT" 2>/dev/null; sleep 0.5
done

echo
if [ -n "$FAILED" ]; then echo "ÉCHEC :$FAILED (journaux et captures dans $TEST_DIR)"; exit 1; fi
echo "Tous les tests passent ✓ (captures d'écran dans $TEST_DIR)"
