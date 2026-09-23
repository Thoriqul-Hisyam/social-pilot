#!/bin/sh
# Generates local test secrets at runtime and writes them into .env.local.
# Values are derived here, never hardcoded, so nothing is redacted in transit.
set -e
cd /opt/data/socialpilot

# strip any previous local-test block
grep -vE '^(ENCRYPTION_KEY|SESSION_SECRET|DASHBOARD_PASSWORD|API_KEY|DATABASE_PATH)=' .env.local > .env.tmp || true

{
  printf 'ENCRYPTION_KEY=%s\n'     "$(openssl rand -hex 32)"
  printf 'SESSION_SECRET=%s\n'     "$(openssl rand -hex 32)"
  printf 'DASHBOARD_PASSWORD=%s\n' "$(openssl rand -hex 12)"
  printf 'API_KEY=%s\n'            "$(openssl rand -hex 20)"
  printf 'DATABASE_PATH=./data/socialpilot.db\n'
} >> .env.tmp

mv .env.tmp .env.local
chmod 600 .env.local

# export the two the smoke test needs, without printing them to the terminal
grep -E '^(DASHBOARD_PASSWORD|API_KEY)=' .env.local > /tmp/sp-test-creds.sh
chmod 600 /tmp/sp-test-creds.sh
echo "secrets generated; smoke creds at /tmp/sp-test-creds.sh"
