#!/usr/bin/env bash
set -euo pipefail

# scripts/mssql-test-up.sh
#
# Brings up the throwaway SQL Server 2022 container defined in
# docker-compose.mssql-test.yml, waits for it to report healthy, then seeds
# it with scripts/mssql-test-seed.sql. Safe to re-run — the seed script
# drops and recreates the calame_test database each time.
#
# Works from Git Bash on Windows as well as macOS/Linux.
#
# Usage:   ./scripts/mssql-test-up.sh
# Teardown: ./scripts/mssql-test-down.sh
# Docs:    docs/mssql-testing.md

cd "$(dirname "${BASH_SOURCE[0]}")/.."

COMPOSE_FILE="docker-compose.mssql-test.yml"
CONTAINER="calame-mssql-test"
SA_PASSWORD="CalameTest!2026x"

echo "==> Starting MSSQL test container..."
docker compose -f "$COMPOSE_FILE" up -d

echo "==> Waiting for SQL Server to report healthy (first pull can take a few minutes)..."
ATTEMPTS=0
MAX_ATTEMPTS=90
until [ "$(docker inspect -f '{{.State.Health.Status}}' "$CONTAINER" 2>/dev/null || echo starting)" = "healthy" ]; do
  ATTEMPTS=$((ATTEMPTS + 1))
  if [ "$ATTEMPTS" -ge "$MAX_ATTEMPTS" ]; then
    echo "!! Timed out waiting for $CONTAINER to become healthy." >&2
    echo "   Check logs with: docker logs $CONTAINER" >&2
    exit 1
  fi
  sleep 2
done
echo "==> Container is healthy."

echo "==> Seeding calame_test database from scripts/mssql-test-seed.sql..."
# MSYS_NO_PATHCONV=1: Git Bash on Windows rewrites arguments that look like
# absolute POSIX paths (e.g. /opt/mssql-tools18/bin/sqlcmd) into a Windows
# path before docker.exe ever sees them, which breaks this exec. Disabling
# path conversion for just this command keeps the container-side path intact.
MSYS_NO_PATHCONV=1 docker exec -i "$CONTAINER" /opt/mssql-tools18/bin/sqlcmd \
  -S localhost -U sa -P "$SA_PASSWORD" -C -b \
  < scripts/mssql-test-seed.sql

echo ""
echo "==> Done. Set CALAME_TEST_MSSQL_DSN to one of:"
echo ""
echo "  ADO-style:"
echo "    export CALAME_TEST_MSSQL_DSN='Server=localhost,14330;Database=calame_test;User Id=sa;Password=${SA_PASSWORD};TrustServerCertificate=true;Encrypt=true'"
echo ""
echo "  URL-style:"
echo "    export CALAME_TEST_MSSQL_DSN='mssql://sa:${SA_PASSWORD}@localhost:14330/calame_test?encrypt=true&trustServerCertificate=true'"
echo ""
echo "Then run: pnpm exec vitest run packages/connectors/src/__tests__/mssql.integration.test.ts"
