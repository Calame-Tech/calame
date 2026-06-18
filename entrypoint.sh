#!/bin/sh
set -e

DEMO_DB="${CALAME_DATA_DIR:-/data}/demo-logistique-v2.db"

if [ ! -f "$DEMO_DB" ]; then
  echo "Generating demo database..."
  DEMO_DB_PATH="$DEMO_DB" node /app/scripts/generate-demo-db.js
  echo "Demo database ready."
fi

exec "$@"
