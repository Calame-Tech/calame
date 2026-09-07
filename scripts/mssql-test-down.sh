#!/usr/bin/env bash
set -euo pipefail

# scripts/mssql-test-down.sh
#
# Stops and removes the MSSQL test container started by
# scripts/mssql-test-up.sh. By default this also removes the named data
# volume so the next `up` starts from a clean slate; pass -k/--keep-data to
# keep it.
#
# Usage: ./scripts/mssql-test-down.sh [-k|--keep-data]

cd "$(dirname "${BASH_SOURCE[0]}")/.."

COMPOSE_FILE="docker-compose.mssql-test.yml"

if [ "${1:-}" = "-k" ] || [ "${1:-}" = "--keep-data" ]; then
  echo "==> Stopping MSSQL test container (keeping data volume)..."
  docker compose -f "$COMPOSE_FILE" down
else
  echo "==> Stopping MSSQL test container and removing its data volume..."
  docker compose -f "$COMPOSE_FILE" down -v
fi

echo "==> Done."
