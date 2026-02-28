# BookStack MCP Remote Server

A remote [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server that exposes your [BookStack](https://www.bookstackapp.com/) knowledge base to Claude.ai as a **Custom Connector**.

It wraps the [`bookstack-mcp-server`](https://github.com/pnocera/bookstack-mcp-server) stdio process with:
- **OAuth 2.0 Authorization Code + PKCE** (required by Claude.ai)
- **Streamable HTTP transport** (MCP protocol over HTTPS)
- **JWT access tokens** (1h) + refresh tokens (30d)
- **Dynamic Client Registration** (Claude registers itself automatically)

## Architecture

```
Claude.ai  ──HTTPS──▶  nginx (TLS termination)
                            │
                            ▼
               bookstack-mcp container (:3100)
               ┌──────────────────────────────────┐
               │  Express HTTP Server              │
               │  ├── /.well-known/oauth-*         │  OAuth metadata
               │  ├── /oauth/register              │  Dynamic Client Registration
               │  ├── /oauth/authorize             │  Consent page
               │  ├── /oauth/token                 │  JWT issuance (PKCE S256)
               │  └── /mcp                         │  Streamable HTTP
               │        │                          │
               │        ▼  child_process (stdio)   │
               │  bookstack-mcp-server             │
               └──────────────────────────────────┘
                            │
                            ▼ (internal Docker network)
               BookStack container (:80)
```

## Prerequisites

- Docker + Docker Compose
- A running [BookStack](https://www.bookstackapp.com/) instance
- A BookStack API token (Settings → API Tokens → Add Token)
- A public domain with HTTPS (e.g. via Let's Encrypt + nginx)

## Quick Start

### 1. Configure environment

```bash
cp .env.example .env
```

Edit `.env` and fill in your values:

| Variable | Description |
|----------|-------------|
| `BOOKSTACK_BASE_URL` | Internal BookStack API URL (e.g. `http://bookstack:80/api`) |
| `BOOKSTACK_API_TOKEN` | `token_id:token_secret` from BookStack settings |
| `JWT_SECRET` | Random secret — generate with `openssl rand -base64 32` |
| `BASE_URL` | Public HTTPS URL of this MCP server |
| `MCP_PORT` | Port inside the container (default: `3100`) |

### 2. Add to your docker-compose.yml

Copy the contents of [`docker-compose.snippet.yml`](docker-compose.snippet.yml) into your existing `docker-compose.yml` (the one that also runs BookStack).

If `bookstack-mcp` runs in the same compose file as `bookstack`, set:
```env
BOOKSTACK_BASE_URL=http://bookstack:80/api
```
This routes traffic directly through the internal Docker network — no TLS overhead, no external roundtrip.

### 3. Configure nginx

Add a new vhost using [`nginx.snippet.conf`](nginx.snippet.conf) as a template and obtain an SSL certificate:

```bash
certbot --nginx -d mcp-bookstack.example.com
```

### 4. Start the service

```bash
docker compose up -d bookstack-mcp
```

### 5. Verify

```bash
curl https://mcp-bookstack.example.com/.well-known/oauth-authorization-server
docker logs bookstack-mcp -f
```

## Connect Claude.ai

1. Open Claude.ai → **Settings** → **Integrations** → **Add custom connector**
2. Set **MCP Server URL** to `https://mcp-bookstack.example.com/mcp`
3. Set **Authentication** to **OAuth**
4. Click **Connect** — a browser window opens with the authorization page
5. Click **Allow Access**
6. Test: ask Claude *"List all BookStack books"*

Claude registers itself automatically via Dynamic Client Registration — no manual client setup required.

## OAuth Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/.well-known/oauth-authorization-server` | RFC 8414 metadata |
| `POST` | `/oauth/register` | Dynamic Client Registration (RFC 7591) |
| `GET` | `/oauth/authorize` | HTML consent page |
| `POST` | `/oauth/authorize` | Issues authorization code |
| `POST` | `/oauth/token` | Code → JWT exchange (PKCE S256) |
| `ALL` | `/mcp` | Authenticated MCP endpoint |

## Token Lifetime

| Token | Lifetime |
|-------|----------|
| Access token | 1 hour |
| Refresh token | 30 days |

Claude refreshes tokens automatically — no manual re-authorization needed until the refresh token expires.

## Docker Hub

```bash
docker pull volkerhaensel/bookstack-mcp-remote:latest
```

## Building Locally

```bash
git clone https://github.com/volker76/bookstack-mcp-remote.git
cd bookstack-mcp-remote
docker build -t bookstack-mcp-remote .
```

## Security Notes

- **Never commit `.env`** — it is listed in `.gitignore`
- **AUTHORIZE_PASSWORD** protects the OAuth consent page — without it anyone who knows the URL can obtain a valid token. Generate with `openssl rand -base64 16`
- **JWT_SECRET** must be set explicitly in production; a random key is generated on startup if not set, invalidating all tokens on restart
- All tokens are signed with HS256; the secret never leaves the container

## License

MIT
