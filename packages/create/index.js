#!/usr/bin/env node
import { execSync, spawnSync } from 'child_process';
import { existsSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { createInterface } from 'readline';

const VERSION = '0.1.0';
const IMAGE = 'ghcr.io/calame-tech/calame';
const DEFAULT_PORT = 4567;

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const GREEN = '\x1b[32m';
const CYAN = '\x1b[36m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';

function ok(msg) { console.log(`  ${GREEN}✓${RESET} ${msg}`); }
function info(msg) { console.log(`  ${CYAN}→${RESET} ${msg}`); }
function warn(msg) { console.log(`  ${YELLOW}⚠${RESET}  ${msg}`); }
function fail(msg) { console.error(`  ${RED}✗${RESET} ${msg}`); }
function dim(msg) { console.log(`${DIM}${msg}${RESET}`); }

function run(cmd, opts = {}) {
  return spawnSync(cmd, { shell: true, encoding: 'utf8', ...opts });
}

function checkDocker() {
  const versionResult = run('docker --version');
  if (versionResult.status !== 0) {
    fail('Docker not found. Install Docker Desktop: https://www.docker.com/products/docker-desktop');
    process.exit(1);
  }
  const version = versionResult.stdout.trim();
  ok(`Docker detected (${version.replace('Docker version ', '')})`);

  const daemonResult = run('docker info', { stdio: 'pipe' });
  if (daemonResult.status !== 0) {
    fail('Docker daemon is not running. Start Docker Desktop and try again.');
    process.exit(1);
  }
  ok('Docker daemon is running');
}

function getDockerCompose() {
  // Try docker compose (v2 plugin) first, fall back to docker-compose (v1)
  if (run('docker compose version').status === 0) return 'docker compose';
  if (run('docker-compose --version').status === 0) return 'docker-compose';
  fail('docker compose not found. Update Docker Desktop to a recent version.');
  process.exit(1);
}

function prompt(question) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => { rl.close(); resolve(answer.trim()); });
  });
}

function openBrowser(url) {
  const platform = process.platform;
  const cmd = platform === 'win32' ? `start "" "${url}"` : platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  run(cmd, { stdio: 'ignore' });
}

function generateDockerCompose(port, dataDir) {
  return `services:
  calame:
    image: ${IMAGE}:latest
    ports:
      - "${port}:4567"
    volumes:
      - ${dataDir}:/data
    env_file:
      - .env
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:4567/health"]
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 10s

volumes:
  calame_data:
`;
}

function generateEnv() {
  return `# Calame configuration
# See https://github.com/Calame-Tech/calame for all options

CALAME_DATA_DIR=/data
# PORT=4567

# LLM provider (required for AI chat features)
# ANTHROPIC_API_KEY=sk-ant-...
# OPENAI_API_KEY=sk-...
`;
}

async function cmdInit() {
  console.log();
  console.log(`${BOLD}  Calame${RESET} ${DIM}v${VERSION}${RESET}`);
  console.log(`  ${DIM}MCP server from your database — in one command${RESET}`);
  console.log();

  // Check Docker
  checkDocker();
  console.log();

  const dc = getDockerCompose();

  // Resolve target directory
  const cwd = process.cwd();
  const composeFile = join(cwd, 'docker-compose.yml');
  const envFile = join(cwd, '.env');

  // Warn if docker-compose.yml already exists
  if (existsSync(composeFile)) {
    warn('docker-compose.yml already exists in this directory.');
    const answer = await prompt('  Overwrite? [y/N] ');
    if (answer.toLowerCase() !== 'y') {
      info('Skipping file generation — using existing docker-compose.yml');
    } else {
      writeFileSync(composeFile, generateDockerCompose(DEFAULT_PORT, 'calame_data'));
      ok('docker-compose.yml updated');
    }
  } else {
    writeFileSync(composeFile, generateDockerCompose(DEFAULT_PORT, 'calame_data'));
    ok('docker-compose.yml created');
  }

  if (!existsSync(envFile)) {
    writeFileSync(envFile, generateEnv());
    ok('.env created (edit to add your API keys)');
  } else {
    dim('    .env already exists, skipping');
  }

  console.log();
  info(`Pulling ${IMAGE}:latest ...`);
  const pull = run(`${dc} pull`, { stdio: 'inherit', cwd });
  if (pull.status !== 0) {
    warn('Could not pull image. Starting with cached version if available...');
  }

  console.log();
  info('Starting Calame...');
  const up = run(`${dc} up -d`, { stdio: 'inherit', cwd });
  if (up.status !== 0) {
    fail('Failed to start Calame.');
    dim(`    Run: ${dc} logs calame`);
    process.exit(1);
  }

  // Wait for health check
  info('Waiting for Calame to be ready...');
  const url = `http://localhost:${DEFAULT_PORT}`;
  let ready = false;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const check = run(`${dc} exec calame wget -qO- http://localhost:4567/health`, { stdio: 'pipe', cwd });
    if (check.status === 0) { ready = true; break; }
  }

  console.log();
  if (ready) {
    ok(`Calame is running at ${BOLD}${CYAN}${url}${RESET}`);
  } else {
    warn(`Calame may still be starting. Open ${url} in your browser.`);
  }

  console.log();
  console.log(`  ${DIM}Useful commands:${RESET}`);
  console.log(`  ${DIM}  ${dc} logs -f calame   # stream logs${RESET}`);
  console.log(`  ${DIM}  ${dc} stop              # stop Calame${RESET}`);
  console.log(`  ${DIM}  ${dc} down              # stop + remove containers${RESET}`);
  console.log();

  openBrowser(url);
}

async function cmdStart() {
  checkDocker();
  const dc = getDockerCompose();
  const composeFile = join(process.cwd(), 'docker-compose.yml');
  if (!existsSync(composeFile)) {
    fail('No docker-compose.yml found. Run: npx create-calame init');
    process.exit(1);
  }
  info('Starting Calame...');
  run(`${dc} up -d`, { stdio: 'inherit' });
  ok(`Calame running at http://localhost:${DEFAULT_PORT}`);
  openBrowser(`http://localhost:${DEFAULT_PORT}`);
}

async function cmdStop() {
  const dc = getDockerCompose();
  info('Stopping Calame...');
  run(`${dc} stop`, { stdio: 'inherit' });
  ok('Calame stopped.');
}

async function cmdLogs() {
  const dc = getDockerCompose();
  execSync(`${dc} logs -f calame`, { stdio: 'inherit' });
}

function printHelp() {
  console.log();
  console.log(`  ${BOLD}create-calame${RESET} ${DIM}v${VERSION}${RESET}`);
  console.log();
  console.log(`  ${BOLD}Usage:${RESET}`);
  console.log(`    npx create-calame [command]`);
  console.log();
  console.log(`  ${BOLD}Commands:${RESET}`);
  console.log(`    ${CYAN}init${RESET}   ${DIM}(default)${RESET}  Set up and start Calame`);
  console.log(`    ${CYAN}start${RESET}             Start existing Calame installation`);
  console.log(`    ${CYAN}stop${RESET}              Stop Calame`);
  console.log(`    ${CYAN}logs${RESET}              Stream Calame logs`);
  console.log(`    ${CYAN}help${RESET}              Show this help`);
  console.log();
  console.log(`  ${BOLD}Example:${RESET}`);
  console.log(`    npx create-calame`);
  console.log();
}

const cmd = process.argv[2] ?? 'init';

switch (cmd) {
  case 'init':
  case undefined:
    cmdInit().catch((e) => { fail(e.message); process.exit(1); });
    break;
  case 'start':
    cmdStart().catch((e) => { fail(e.message); process.exit(1); });
    break;
  case 'stop':
    cmdStop().catch((e) => { fail(e.message); process.exit(1); });
    break;
  case 'logs':
    cmdLogs().catch((e) => { fail(e.message); process.exit(1); });
    break;
  case 'help':
  case '--help':
  case '-h':
    printHelp();
    break;
  default:
    fail(`Unknown command: ${cmd}`);
    printHelp();
    process.exit(1);
}
