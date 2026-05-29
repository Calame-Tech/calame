/**
 * Test script for Calame chat engine — small models via OpenRouter
 *
 * Usage:
 *   CALAME_SESSION=<cookie> node scripts/test-chat-models.js
 *   CALAME_TOKEN=<bearer>   node scripts/test-chat-models.js
 *
 * Options (env vars):
 *   CALAME_BASE     Base URL of Calame (default: http://localhost:4567)
 *   CALAME_SESSION  Admin session cookie value (calame_session=...)
 *   CALAME_TOKEN    Bearer token
 *   CALAME_PROFILE  Profile name (default: test-logistique)
 *   MODELS          Comma-separated OpenRouter model IDs (default: see below)
 */

const CALAME_BASE    = process.env.CALAME_BASE    || 'http://localhost:4567';
const CALAME_PROFILE = process.env.CALAME_PROFILE || 'test-logistique';
const SESSION_COOKIE = process.env.CALAME_SESSION;
const BEARER_TOKEN   = process.env.CALAME_TOKEN;

const DEFAULT_MODELS = [
  'qwen/qwen3.5-35b-a3b',
  'qwen/qwen-2.5-7b-instruct',
  'mistralai/mistral-7b-instruct',
];

const MODELS = process.env.MODELS
  ? process.env.MODELS.split(',').map(m => m.trim())
  : DEFAULT_MODELS;

if (!SESSION_COOKIE && !BEARER_TOKEN) {
  console.error('❌  Auth required. Set CALAME_SESSION or CALAME_TOKEN.');
  console.error('   Get your session: open DevTools → Application → Cookies → calame_session');
  console.error('   Then: CALAME_SESSION=<value> node scripts/test-chat-models.js');
  process.exit(1);
}

// ── Ground truth (pre-computed from demo-logistique-v2.db) ──────────────────
const GROUND_TRUTH = {
  colis_livre:             8009,
  colis_en_cours:          1936,
  incidents_resolus:        269,
  top_livreur_nom:        'Bernard',
  total_paiements_valides: 220054.22,
};

// ── Test questions ───────────────────────────────────────────────────────────
const QUESTIONS = [
  {
    id: 'explore-tables',
    category: 'explore',
    q: 'Quelles tables as-tu à disposition ?',
    check: null,
  },
  {
    id: 'explore-describe',
    category: 'explore',
    q: 'Décris la structure de la table colis. Quelles informations y sont stockées ?',
    check: null,
  },
  {
    id: 'query-count-livre',
    category: 'query',
    q: "Combien de colis ont le statut 'livré' ?",
    check: (text) => {
      // Accept French formatting: 8009 or 8 009 or 8,009
      const n = GROUND_TRUTH.colis_livre;
      const normalized = text.replace(/[\s,]/g, '');
      return normalized.includes(String(n))
        ? { ok: true, detail: `✓ Contient ${n}` }
        : { ok: false, detail: `✗ Attendu ${n}, non trouvé` };
    },
  },
  {
    id: 'query-count-en-cours',
    category: 'query',
    q: 'Combien de colis sont actuellement en cours de livraison ?',
    check: (text) => {
      const n = GROUND_TRUTH.colis_en_cours;
      const normalized = text.replace(/[\s,]/g, '');
      return normalized.includes(String(n))
        ? { ok: true, detail: `✓ Contient ${n}` }
        : { ok: false, detail: `✗ Attendu ${n}, non trouvé` };
    },
  },
  {
    id: 'query-top-livreur',
    category: 'query',
    q: 'Quel livreur a livré le plus de colis ? Donne son nom et son nombre de livraisons.',
    check: (text) => {
      const nom = GROUND_TRUTH.top_livreur_nom;
      return text.toLowerCase().includes(nom.toLowerCase())
        ? { ok: true, detail: `✓ Contient "${nom}"` }
        : { ok: false, detail: `✗ Attendu "${nom}", non trouvé` };
    },
  },
  {
    id: 'query-incidents-resolus',
    category: 'query',
    q: "Combien d'incidents ont été résolus ?",
    check: (text) => {
      const n = GROUND_TRUTH.incidents_resolus;
      return text.includes(String(n))
        ? { ok: true, detail: `✓ Contient ${n}` }
        : { ok: false, detail: `✗ Attendu ${n}, non trouvé` };
    },
  },
  {
    id: 'query-paiements-total',
    category: 'query',
    q: 'Quel est le montant total des paiements validés ?',
    check: (text) => {
      // Accept rounding variations: 220054 or 220,054
      return /220\s*[,.]?\s*054/.test(text.replace(/\s/g, ''))
        ? { ok: true, detail: '✓ Montant ~220 054 €' }
        : { ok: false, detail: `✗ Attendu ~220054, non trouvé` };
    },
  },
  {
    id: 'compute-calc',
    category: 'compute',
    q: 'Calcule 1250 + 875 + 340',
    check: (text) => {
      return text.includes('2465')
        ? { ok: true, detail: '✓ Résultat 2465' }
        : { ok: false, detail: '✗ Attendu 2465, non trouvé' };
    },
  },
];

// ── SSE stream reader ────────────────────────────────────────────────────────

async function streamChat(message, model) {
  const headers = { 'Content-Type': 'application/json' };
  if (SESSION_COOKIE) headers['Cookie'] = `calame_session=${SESSION_COOKIE}`;
  if (BEARER_TOKEN)   headers['Authorization'] = `Bearer ${BEARER_TOKEN}`;

  const body = JSON.stringify({
    message,
    profileName: CALAME_PROFILE,
    aiSettingName: 'qwenopenrouteur',
    history: [],
  });

  const res = await fetch(`${CALAME_BASE}/api/chat/stream`, { method: 'POST', headers, body });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  }

  const events = { text_delta: [], tool_call: [], tool_result: [], usage: null, error: null };
  let fullText = '';

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    let eventType = null;
    for (const line of lines) {
      if (line.startsWith('event: ')) {
        eventType = line.slice(7).trim();
      } else if (line.startsWith('data: ') && eventType) {
        try {
          const data = JSON.parse(line.slice(6));
          if (eventType === 'text_delta') { fullText += data.delta ?? ''; events.text_delta.push(data.delta); }
          else if (eventType === 'tool_call') events.tool_call.push(data.name);
          else if (eventType === 'tool_result') events.tool_result.push({ name: data.name, ok: data.ok });
          else if (eventType === 'usage') events.usage = data;
          else if (eventType === 'error') events.error = data.message;
        } catch { /* ignore malformed SSE */ }
        eventType = null;
      }
    }
  }

  return { fullText, ...events };
}

// ── Formatting helpers ───────────────────────────────────────────────────────

function truncate(str, n = 120) {
  return str.length <= n ? str : str.slice(0, n) + '…';
}

function pad(str, n) {
  return String(str).padEnd(n);
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function runModel(model) {
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  Model: ${model}`);
  console.log('═'.repeat(70));

  const results = [];

  for (const q of QUESTIONS) {
    process.stdout.write(`  [${q.id}] … `);
    const t0 = Date.now();
    let result;
    try {
      result = await streamChat(q.q, model);
    } catch (err) {
      console.log(`ERROR: ${err.message}`);
      results.push({ id: q.id, category: q.category, ok: null, detail: err.message, latency: Date.now() - t0, tools: [], tokens: null, response: '' });
      continue;
    }

    const latency = Date.now() - t0;
    const checkResult = q.check ? q.check(result.fullText) : null;
    const ok = result.error ? false : (checkResult ? checkResult.ok : null);

    const icon = result.error ? '💥' : checkResult === null ? '📋' : checkResult.ok ? '✅' : '❌';
    console.log(`${icon} ${latency}ms | tools: [${result.tool_call.join(', ')}]`);

    results.push({
      id: q.id,
      category: q.category,
      ok,
      detail: result.error ?? (checkResult?.detail ?? '(pas de vérification)'),
      latency,
      tools: result.tool_call,
      toolsFailed: result.tool_result.filter(r => !r.ok).map(r => r.name),
      tokens: result.usage,
      response: result.fullText,
    });
  }

  // ── Summary table ─────────────────────────────────────────────────────────
  console.log(`\n  ${'─'.repeat(66)}`);
  console.log(`  ${pad('ID', 28)} ${pad('Cat.', 9)} ${pad('Résultat', 28)} ${pad('ms', 6)}`);
  console.log(`  ${'─'.repeat(66)}`);
  for (const r of results) {
    const status = r.ok === null ? '—' : r.ok ? 'OK' : 'KO';
    console.log(`  ${pad(r.id, 28)} ${pad(r.category, 9)} ${pad(r.detail.slice(0,27), 28)} ${pad(r.latency, 6)}`);
  }
  console.log(`  ${'─'.repeat(66)}`);

  const verifiable  = results.filter(r => r.ok !== null);
  const passed      = verifiable.filter(r => r.ok === true).length;
  const toolsFailed = results.some(r => r.toolsFailed?.length > 0);
  const avgLatency  = Math.round(results.reduce((s, r) => s + r.latency, 0) / results.length);
  const totalTools  = results.reduce((s, r) => s + r.tools.length, 0);

  console.log(`\n  Score vérifiable : ${passed}/${verifiable.length}`);
  console.log(`  Tools appelés    : ${totalTools} (${results.filter(r=>r.tools.length>0).length} questions)`);
  if (toolsFailed) console.log(`  ⚠  Certains tool calls ont échoué`);
  console.log(`  Latence moyenne  : ${avgLatency}ms`);

  // ── Réponses détaillées ───────────────────────────────────────────────────
  console.log(`\n  ── Réponses ─────────────────────────────────────────────────`);
  for (const r of results) {
    console.log(`\n  [${r.id}]`);
    console.log(`  Tools : ${r.tools.length > 0 ? r.tools.join(', ') : 'aucun'}`);
    console.log(`  Réponse : ${truncate(r.response, 200)}`);
  }

  return results;
}

async function main() {
  console.log(`\nCalame chat test — ${new Date().toISOString()}`);
  console.log(`Profil : ${CALAME_PROFILE}  |  Base : ${CALAME_BASE}`);
  console.log(`Modèles : ${MODELS.join(', ')}`);
  console.log(`Questions : ${QUESTIONS.length}`);

  // Verify Calame is running (any response = server up)
  try {
    await fetch(`${CALAME_BASE}/api/serve/status`);
  } catch {
    console.error(`\n❌  Calame ne répond pas sur ${CALAME_BASE}`);
    console.error(`   Lance le serveur d'abord : pnpm dev`);
    process.exit(1);
  }

  const allResults = {};
  for (const model of MODELS) {
    allResults[model] = await runModel(model);
  }

  // ── Cross-model comparison ─────────────────────────────────────────────────
  if (MODELS.length > 1) {
    console.log(`\n${'═'.repeat(70)}`);
    console.log('  Comparaison inter-modèles');
    console.log('═'.repeat(70));
    const verifiableIds = QUESTIONS.filter(q => q.check).map(q => q.id);
    console.log(`\n  ${pad('Question', 28)} ${MODELS.map(m => pad(m.split('/')[1]?.slice(0,14) ?? m.slice(0,14), 16)).join(' ')}`);
    console.log(`  ${'─'.repeat(28 + MODELS.length * 17)}`);
    for (const id of verifiableIds) {
      const row = MODELS.map(m => {
        const r = allResults[m]?.find(x => x.id === id);
        return pad(r ? (r.ok ? 'OK' : 'KO') : '?', 16);
      }).join(' ');
      console.log(`  ${pad(id, 28)} ${row}`);
    }
  }

  console.log('\n✅  Test terminé.\n');
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
