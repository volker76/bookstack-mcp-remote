/**
 * BookStack MCP Remote Server
 *
 * Wraps the local bookstack-mcp-server (stdio) as a remote MCP service
 * reachable via Streamable HTTP, secured with OAuth 2.0 / PKCE.
 *
 * Endpoints:
 *   GET  /.well-known/oauth-authorization-server  – OAuth metadata (RFC 8414)
 *   POST /oauth/register                          – Dynamic Client Registration (RFC 7591)
 *   GET  /oauth/authorize                         – Authorization page
 *   POST /oauth/authorize                         – Issue authorization code
 *   POST /oauth/token                             – Exchange code / refresh token
 *   ALL  /mcp                                     – MCP Streamable HTTP (auth required)
 */

import express from 'express';
import { randomBytes, createHash } from 'crypto';
import { spawn } from 'child_process';
import { SignJWT, jwtVerify } from 'jose';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

// ─── Config ───────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.MCP_PORT || '3100', 10);
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');

let jwtSecret;
if (process.env.JWT_SECRET) {
  jwtSecret = new TextEncoder().encode(process.env.JWT_SECRET);
} else {
  jwtSecret = new TextEncoder().encode(randomBytes(32).toString('hex'));
  console.warn('WARNING: JWT_SECRET not set – tokens will be invalidated on restart.');
}

// ─── In-memory stores ─────────────────────────────────────────────────────────

const registeredClients = new Map(); // clientId → { redirectUris }
const pendingCodes      = new Map(); // code → { clientId, redirectUri, codeChallenge, codeChallengeMethod, expiresAt }
const mcpSessions       = new Map(); // sessionId → { transport, child }

// ─── App setup ────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ─── OAuth: Metadata (RFC 8414) ───────────────────────────────────────────────

app.get('/.well-known/oauth-authorization-server', (_req, res) => {
  res.json({
    issuer: BASE_URL,
    authorization_endpoint:             `${BASE_URL}/oauth/authorize`,
    token_endpoint:                     `${BASE_URL}/oauth/token`,
    registration_endpoint:              `${BASE_URL}/oauth/register`,
    response_types_supported:           ['code'],
    grant_types_supported:              ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported:   ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
  });
});

// ─── OAuth: Dynamic Client Registration (RFC 7591) ───────────────────────────

app.post('/oauth/register', (req, res) => {
  const clientId    = randomBytes(16).toString('hex');
  const redirectUris = Array.isArray(req.body?.redirect_uris) ? req.body.redirect_uris : [];
  registeredClients.set(clientId, { redirectUris });

  res.status(201).json({
    client_id:                  clientId,
    redirect_uris:              redirectUris,
    grant_types:                ['authorization_code'],
    response_types:             ['code'],
    token_endpoint_auth_method: 'none',
  });
});

// ─── OAuth: Authorization page ────────────────────────────────────────────────

app.get('/oauth/authorize', (req, res) => {
  const { response_type, client_id, redirect_uri, state, code_challenge, code_challenge_method } = req.query;

  if (response_type !== 'code') {
    return res.status(400).send('unsupported_response_type');
  }

  res.type('html').send(buildAuthorizePage({
    client_id, redirect_uri, state, code_challenge, code_challenge_method,
  }));
});

// ─── OAuth: Issue authorization code ─────────────────────────────────────────

app.post('/oauth/authorize', (req, res) => {
  const { client_id, redirect_uri, state, code_challenge, code_challenge_method } = req.body;

  if (!redirect_uri) return res.status(400).send('missing redirect_uri');

  const code      = randomBytes(32).toString('base64url');
  const expiresAt = Date.now() + 600_000; // 10 minutes

  pendingCodes.set(code, {
    clientId:            client_id,
    redirectUri:         redirect_uri,
    codeChallenge:       code_challenge,
    codeChallengeMethod: code_challenge_method || 'S256',
    expiresAt,
  });
  setTimeout(() => pendingCodes.delete(code), 600_000);

  const url = new URL(redirect_uri);
  url.searchParams.set('code', code);
  if (state) url.searchParams.set('state', state);

  res.redirect(302, url.toString());
});

// ─── OAuth: Token endpoint ────────────────────────────────────────────────────

app.post('/oauth/token', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  const { grant_type, code, code_verifier, refresh_token } = req.body;

  // ── authorization_code ──
  if (grant_type === 'authorization_code') {
    const stored = pendingCodes.get(code);
    if (!stored || stored.expiresAt < Date.now()) {
      return res.status(400).json({ error: 'invalid_grant' });
    }
    pendingCodes.delete(code);

    // Validate PKCE (S256)
    if (stored.codeChallenge) {
      if (!code_verifier) {
        return res.status(400).json({ error: 'invalid_grant', error_description: 'code_verifier required' });
      }
      const computed = createHash('sha256').update(code_verifier).digest('base64url');
      if (computed !== stored.codeChallenge) {
        return res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE mismatch' });
      }
    }

    const [accessToken, refreshToken] = await Promise.all([
      mintJwt({ sub: stored.clientId, type: 'access' },  '1h'),
      mintJwt({ sub: stored.clientId, type: 'refresh' }, '30d'),
    ]);

    return res.json({
      access_token:  accessToken,
      token_type:    'bearer',
      expires_in:    3600,
      refresh_token: refreshToken,
    });
  }

  // ── refresh_token ──
  if (grant_type === 'refresh_token') {
    try {
      const { payload } = await jwtVerify(refresh_token, jwtSecret);
      if (payload.type !== 'refresh') throw new Error('wrong type');

      const accessToken = await mintJwt({ sub: payload.sub, type: 'access' }, '1h');
      return res.json({
        access_token:  accessToken,
        token_type:    'bearer',
        expires_in:    3600,
        refresh_token, // reuse the existing refresh token
      });
    } catch {
      return res.status(400).json({ error: 'invalid_grant' });
    }
  }

  res.status(400).json({ error: 'unsupported_grant_type' });
});

// ─── Auth middleware ──────────────────────────────────────────────────────────

async function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    await jwtVerify(auth.slice(7), jwtSecret);
    next();
  } catch {
    res.status(401).json({ error: 'invalid_token' });
  }
}

// ─── MCP: session factory ─────────────────────────────────────────────────────

function spawnChild() {
  return spawn('bookstack-mcp-server', [], {
    env: {
      PATH:                  process.env.PATH,
      HOME:                  process.env.HOME,
      BOOKSTACK_BASE_URL:    process.env.BOOKSTACK_BASE_URL || '',
      BOOKSTACK_API_TOKEN:   process.env.BOOKSTACK_API_TOKEN || '',
    },
    stdio: ['pipe', 'pipe', 'inherit'], // stderr → host stderr for debugging
  });
}

function newMcpSession() {
  const child = spawnChild();
  let sessionId = null;

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => {
      sessionId = randomBytes(16).toString('hex');
      return sessionId;
    },
    onsessioninitialized: (id) => {
      mcpSessions.set(id, session);
      console.log(`[mcp] session initialized: ${id}`);
    },
  });

  const session = { transport, child };

  // ── child stdout → HTTP transport (line-delimited JSON) ──
  let buf = '';
  child.stdout.on('data', (chunk) => {
    buf += chunk.toString();
    const lines = buf.split('\n');
    buf = lines.pop(); // keep incomplete trailing line
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        transport.send(JSON.parse(line)).catch((e) => console.error('[relay→http]', e.message));
      } catch (e) {
        console.error('[stdout parse]', e.message, '| line:', line.slice(0, 120));
      }
    }
  });

  // ── HTTP transport → child stdin ──
  transport.onmessage = (msg) => {
    child.stdin.write(JSON.stringify(msg) + '\n');
  };

  // ── cleanup ──
  child.on('exit', (code, signal) => {
    console.log(`[mcp] child exited (code=${code}, signal=${signal}) session=${sessionId}`);
    if (sessionId) mcpSessions.delete(sessionId);
    transport.close().catch(() => {});
  });

  transport.onclose = () => {
    console.log(`[mcp] transport closed, session=${sessionId}`);
    if (sessionId) mcpSessions.delete(sessionId);
    child.kill();
  };

  return session;
}

// ─── MCP endpoint ─────────────────────────────────────────────────────────────

app.all('/mcp', requireAuth, async (req, res) => {
  try {
    const sid = req.headers['mcp-session-id'];

    if (sid) {
      const session = mcpSessions.get(sid);
      if (!session) {
        return res.status(404).json({ error: 'session_not_found' });
      }
      await session.transport.handleRequest(req, res, req.body);
    } else if (req.method === 'POST') {
      // First request — no session ID yet; create a new session
      const session = newMcpSession();
      await session.transport.handleRequest(req, res, req.body);
    } else {
      res.status(400).json({ error: 'missing_session_id' });
    }
  } catch (err) {
    console.error('[mcp] handler error:', err);
    if (!res.headersSent) res.status(500).json({ error: 'internal_error' });
  }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function mintJwt(payload, expiresIn) {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(jwtSecret);
}

/** Escape HTML special characters to prevent XSS in the authorize page. */
function esc(s) {
  return String(s ?? '')
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;')
    .replace(/'/g,  '&#39;');
}

function buildAuthorizePage({ client_id, redirect_uri, state, code_challenge, code_challenge_method }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>BookStack MCP — Authorize</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #f1f5f9;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
    }
    .card {
      background: #fff;
      border-radius: 12px;
      padding: 2rem;
      width: 100%;
      max-width: 360px;
      box-shadow: 0 4px 24px rgba(0, 0, 0, 0.08);
    }
    .logo {
      width: 44px; height: 44px;
      background: #2563eb;
      border-radius: 10px;
      display: flex;
      align-items: center;
      justify-content: center;
      margin-bottom: 1.25rem;
    }
    h1 { font-size: 1.1rem; font-weight: 600; color: #0f172a; margin-bottom: 0.5rem; }
    p  { font-size: 0.875rem; color: #64748b; line-height: 1.6; margin-bottom: 1.75rem; }
    p strong { color: #0f172a; }
    button {
      width: 100%;
      padding: 0.75rem;
      background: #2563eb;
      color: #fff;
      border: none;
      border-radius: 8px;
      font-size: 0.95rem;
      font-weight: 500;
      cursor: pointer;
      transition: background 0.15s;
    }
    button:hover { background: #1d4ed8; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">
      <!-- Book icon -->
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none"
           stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/>
        <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>
      </svg>
    </div>
    <h1>Authorize BookStack MCP</h1>
    <p><strong>Claude.ai</strong> is requesting access to your BookStack knowledge base via the MCP protocol.</p>
    <form method="POST" action="/oauth/authorize">
      <input type="hidden" name="client_id"            value="${esc(client_id)}">
      <input type="hidden" name="redirect_uri"         value="${esc(redirect_uri)}">
      <input type="hidden" name="state"                value="${esc(state)}">
      <input type="hidden" name="code_challenge"       value="${esc(code_challenge)}">
      <input type="hidden" name="code_challenge_method" value="${esc(code_challenge_method)}">
      <button type="submit">Allow Access</button>
    </form>
  </div>
</body>
</html>`;
}

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, '0.0.0.0', () => {
  console.log(`BookStack MCP Remote running on :${PORT}`);
  console.log(`Base URL: ${BASE_URL}`);
});
