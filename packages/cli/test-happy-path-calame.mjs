#!/usr/bin/env node
// Test happy path SQL complet via API Calame — avec user auth
const BASE = 'http://localhost:4567';
const TEST_PASSWORD = process.env.CALAME_E2E_PASSWORD;

if (!TEST_PASSWORD) {
  throw new Error('CALAME_E2E_PASSWORD is required');
}

async function api(path, opts = {}) {
  const url = `${BASE}${path}`;
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    ...opts.headers,
  };
  const body = opts.body ? JSON.stringify(opts.body) : undefined;
  
  if (opts.withCookies) {
    headers['Cookie'] = opts.withCookies;
  }
  
  const res = await fetch(url, {
    method: opts.method || 'GET',
    headers,
    body,
  });
  
  const setCookie = res.headers.get('set-cookie');
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    const dataLine = text
      .split('\n')
      .find((line) => line.startsWith('data:'))
      ?.slice(5)
      .trim();
    if (dataLine) {
      try {
        json = JSON.parse(dataLine);
      } catch {
        json = text;
      }
    } else {
      json = text;
    }
  }
  
  return { status: res.status, body: json, setCookie };
}

function mcpPayload(response) {
  const text = response.body?.result?.content?.[0]?.text;
  if (typeof text !== 'string') return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function main() {
  let cookie = null;
  
  console.log('=== Calame Happy Path SQL — Complet (Demo SQLite) ===\n');
  
  // 1. Setup admin
  console.log('1️⃣  Setup admin account...');
  const setup = await api('/api/auth/setup', {
    method: 'POST',
    body: { name: 'Admin', email: 'admin@test.com', password: TEST_PASSWORD },
  });
  console.log(`   Status: ${setup.status}`, setup.status === 200 ? '✅' : setup.status === 403 ? '⚠️  already exists' : '❌');
  
  // 2. Login admin
  console.log('\n2️⃣  Login admin...');
  const login = await api('/api/auth/login', {
    method: 'POST',
    body: { email: 'admin@test.com', password: TEST_PASSWORD },
  });
  console.log(`   Status: ${login.status}`, login.status === 200 ? '✅' : '❌');
  cookie = login.setCookie;
  
  // 3. Create demo connection
  console.log('\n3️⃣  Create demo SQLite connection...');
  const demo = await api('/api/connections/demo', {
    method: 'POST',
    withCookies: cookie,
  });
  console.log(`   Status: ${demo.status}`, demo.status === 200 ? '✅' : '❌');
  if (demo.status === 200) {
    console.log(`   Tables: ${demo.body?.tableCount || 0}`);
  }
  
  // 4. Create profile
  console.log('\n4️⃣  Create profile...');
  const profile = await api('/api/profiles/save', {
    method: 'POST',
    withCookies: cookie,
    body: {
      profiles: {
        'demo-profile': {
          name: 'demo-profile',
          label: 'Demo Profile',
          authMode: 'token',
          sources: ['demo-logistique'],
          scopes: {
            'demo-logistique': {
              kind: 'relational',
              selectedTables: {
                client: ['id', 'nom', 'prenom', 'email', 'ville'],
                colis: ['id', 'reference', 'statut', 'ville_livraison'],
              },
            },
          },
          dataScopeRules: [],
          sharedTables: [],
          isTokenAuth: true,
        },
      },
    },
  });
  console.log(`   Status: ${profile.status}`, profile.status === 200 ? '✅' : '❌');
  
  // 5. Serve start (active le profile)
  console.log('\n5️⃣  Serve start (activate profile)...');
  const serveStart = await api('/api/serve/start', {
    method: 'POST',
    withCookies: cookie,
    body: { profiles: ['demo-profile'] },
  });
  console.log(`   Status: ${serveStart.status}`, serveStart.status === 200 ? '✅' : '❌');
  
  // 6. Create user (legacy format: profileName + accessMode séparément)
  console.log('\n6️⃣  Create user with profile access (legacy format)...');
  const user = await api('/api/users', {
    method: 'POST',
    withCookies: cookie,
    body: {
      name: 'Test User',
      email: `user-${Date.now()}@test.local`,
      role: 'user',
      profileName: 'demo-profile',
      accessMode: 'mcp',
    },
  });
  console.log(`   Status: ${user.status}`, user.status === 200 ? '✅' : '❌');
  if (user.status !== 200) {
    console.log(`   Error:`, JSON.stringify(user.body).slice(0, 300));
  }
  let userToken = null;
  if (user.status === 200) {
    const activation = await api(`/api/onboarding/${user.body?.onboardingCode}/activate`, {
      method: 'POST',
      body: { password: TEST_PASSWORD },
    });
    console.log(`   Activation: ${activation.status}`, activation.status === 200 ? '✅' : '❌');
    userToken = activation.body?.plaintextToken;
    console.log(`   User: ${user.body?.user?.id?.slice(0, 8)}...`);
    console.log(`   Token received: ${Boolean(userToken)}`);
  }
  
  // 7. MCP tools list with user token
  console.log('\n7️⃣  MCP tools list (user token)...');
  const tools = await api('/mcp/demo-profile', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${userToken}` },
    body: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
  });
  console.log(`   Status: ${tools.status}`, tools.status === 200 ? '✅' : '❌');
  if (tools.status === 200) {
    const toolList = tools.body?.result?.tools || [];
    console.log(`   Tools available: ${toolList.length}`);
    for (const t of toolList.slice(0, 10)) {
      console.log(`     - ${t.name}: ${t.description?.slice(0, 70) || 'no desc'}...`);
    }
    if (!toolList.some((tool) => tool.name === 'query')) {
      throw new Error('query tool is not exposed');
    }
  } else {
    console.log(`   Error:`, JSON.stringify(tools.body).slice(0, 200));
  }
  
  // 8. Query allow (authorized - only selected columns)
  console.log('\n8️⃣  Query allow (authorized - selected columns only)...');
  const queryAllow = await api('/mcp/demo-profile', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${userToken}` },
    body: {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'query',
        arguments: {
          table: 'client',
          columns: ['id', 'nom', 'prenom', 'email', 'ville'],
          limit: 5,
        },
      },
    },
  });
  console.log(`   Status: ${queryAllow.status}`, queryAllow.status === 200 ? '✅' : '❌');
  if (queryAllow.status === 200) {
    const result = mcpPayload(queryAllow);
    console.log(`   Payload:`, JSON.stringify(result).slice(0, 500));
    const rows = Array.isArray(result) ? result : (result?.rows ?? result?.data ?? []);
    console.log(`   Result rows: ${rows.length}`);
    if (rows.length > 0) {
      console.log(`   Sample:`, JSON.stringify(rows[0]).slice(0, 120));
    }
    if (rows.length !== 5) throw new Error(`expected 5 allowed rows, got ${rows.length}`);
  } else {
    console.log(`   Error:`, JSON.stringify(queryAllow.body).slice(0, 200));
  }
  
  // 9. Query deny (blocked column - telephone should be excluded)
  console.log('\n9️⃣  Query deny (blocked column - telephone)...');
  const queryDeny = await api('/mcp/demo-profile', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${userToken}` },
    body: {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'query',
        arguments: {
          table: 'client',
          columns: ['id', 'nom', 'telephone'],
          limit: 5,
        },
      },
    },
  });
  console.log(`   Status: ${queryDeny.status}`);
  if (queryDeny.status === 200) {
    const result = mcpPayload(queryDeny);
    const rejected = queryDeny.body?.result?.isError === true;
    console.log(`   Rejected: ${rejected}`);
    console.log(`   Result:`, JSON.stringify(result).slice(0, 200));
    if (!rejected) throw new Error('blocked column query was not rejected');
  } else {
    console.log(`   Error:`, JSON.stringify(queryDeny.body).slice(0, 200));
  }
  
  // 10. Check audit
  console.log('\n🔟  Check audit log...');
  const audit = await api('/api/audit?profileName=demo-profile&limit=20', { withCookies: cookie });
  console.log(`   Status: ${audit.status}`, audit.status === 200 ? '✅' : '❌');
  if (audit.status === 200) {
    const entries = audit.body?.entries || [];
    console.log(`   Audit entries: ${entries.length}`);
    for (const e of entries.slice(-5)) {
      console.log(`     - ${e.toolName} | ${e.result} | ${e.timestamp?.slice(0, 19) || 'N/A'}`);
    }
    if (entries.length < 2) throw new Error(`expected at least 2 audit entries, got ${entries.length}`);
  }
  
  console.log('\n✅ Calame Happy Path SQL test complete\n');
}

main().catch(e => {
  console.error('❌ Test FAILED:', e.message);
  process.exit(1);
});
