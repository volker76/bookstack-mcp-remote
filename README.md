# BookStack MCP Remote Server

A remote [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server that exposes your [BookStack](https://www.bookstackapp.com/) knowledge base to Claude.ai as a **Custom Connector**.

It wraps the [`bookstack-mcp-server`](https://github.com/pnocera/bookstack-mcp-server) stdio process with:
- **OAuth 2.0 Authorization Code + PKCE** (required by Claude.ai)
- **Per-user BookStack token** — each user authenticates with their own API token
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
               │  ├── /oauth/authorize             │  Consent page + token validation
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

## Auth Flow

```
1. Claude.ai opens the OAuth consent page
2. User enters their BookStack API token (token_id:token_secret)
3. Server validates token live: GET /api/books against BookStack
4. Valid → authorization code issued, redirect back to Claude
5. Claude exchanges code for JWT (PKCE S256 verified)
6. BookStack token is stored in the JWT payload (bst claim, signed HS256)
7. Each MCP request: token extracted from JWT → passed to child process
```

No central user management needed — BookStack is both the auth source and the resource.

## Prerequisites

- Docker + Docker Compose (or Portainer)
- A running [BookStack](https://www.bookstackapp.com/) instance
- A public domain with HTTPS (e.g. via Let's Encrypt + nginx)

Each user needs their own BookStack API token: **Settings → API Tokens → Add Token**

## Quick Start

### 1. Configure environment

```bash
cp .env.example .env
```

Edit `.env` and fill in your values:

| Variable | Required | Description |
|----------|----------|-------------|
| `BOOKSTACK_BASE_URL` | ✓ | Internal BookStack API URL, e.g. `http://bookstack:80/api` |
| `JWT_SECRET` | ✓ | Random secret — generate with `openssl rand -base64 32` |
| `BASE_URL` | ✓ | Public HTTPS URL of this MCP server |
| `MCP_PORT` | | Port inside the container (default: `3100`) |
| `DEBUG` | | Set to `true` to enable auth debug logging |

### 2. Add to your docker-compose.yml

Copy the contents of [`docker-compose.snippet.yml`](docker-compose.snippet.yml) into your existing `docker-compose.yml` (the one that also runs BookStack).

If `bookstack-mcp` runs in the same compose file as `bookstack`, set:
```env
BOOKSTACK_BASE_URL=http://bookstack:80/api
```
This routes traffic directly through the internal Docker network — no TLS overhead, no external roundtrip.

**Example** (linuxserver/bookstack + bookstack-mcp in the same stack):

```yaml
services:
  bookstack-mcp:
    image: volkerhaensel/bookstack-mcp-remote:latest
    container_name: bookstack-mcp
    env_file: stack.env
    environment:
      - MCP_PORT=3100
    ports:
      - "127.0.0.1:3100:3100"   # only reachable via nginx, not from the internet
    restart: unless-stopped
    depends_on:
      - bookstack

  bookstack:
    image: lscr.io/linuxserver/bookstack:latest
    container_name: bookstack
    environment:
      - PUID=1000
      - PGID=1000
      - TZ=Europe/Berlin
      - APP_URL=https://bookstack.example.com
      - APP_KEY=base64:your-app-key-here
      - DB_HOST=your-db-host
      - DB_PORT=3306
      - DB_USERNAME=bookstack
      - DB_PASSWORD=your-db-password
      - DB_DATABASE=bookstack
      - MAIL_DRIVER=smtp
      - MAIL_HOST=your-mail-host
      - MAIL_PORT=25
      - MAIL_FROM=no-reply@example.com
      - MAIL_FROM_NAME=BookStack
      - MAIL_ENCRYPTION=null
    volumes:
      - bookstack_config:/config
    ports:
      - "127.0.0.1:6875:80"
    restart: unless-stopped

volumes:
  bookstack_config:
```

The corresponding `stack.env` for the `bookstack-mcp` service:

```env
# Internal BookStack URL via Docker network (no TLS overhead)
BOOKSTACK_BASE_URL=http://bookstack:80/api

# Secret for signing JWTs — generate with: openssl rand -base64 32
JWT_SECRET=your-jwt-secret

# Public HTTPS URL of this MCP server
BASE_URL=https://mcp-bookstack.example.com
```

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
4. Click **Connect** — a browser window opens with the consent page
5. Enter your BookStack API token (`token_id:token_secret`)
6. Click **Allow Access**
7. Test: ask Claude *"List all BookStack books"*

Claude registers itself automatically via Dynamic Client Registration — no manual client setup required.

## OAuth Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/.well-known/oauth-authorization-server` | RFC 8414 metadata |
| `POST` | `/oauth/register` | Dynamic Client Registration (RFC 7591) |
| `GET` | `/oauth/authorize` | HTML consent page |
| `POST` | `/oauth/authorize` | Validates BookStack token, issues authorization code |
| `POST` | `/oauth/token` | Code → JWT exchange (PKCE S256) |
| `ALL` | `/mcp` | Authenticated MCP endpoint |

## Token Lifetime

| Token | Lifetime |
|-------|----------|
| Access token | 1 hour |
| Refresh token | 30 days |

Claude refreshes tokens automatically — no manual re-authorization needed until the refresh token expires.

## Debugging

Set `DEBUG=true` in the environment to enable auth debug output in the container logs:

```
[auth] validating token against http://bookstack:80/api/books?count=1
[auth] BookStack responded: 200
```

```bash
docker logs bookstack-mcp -f
```

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
- **JWT_SECRET** must be set explicitly in production; a random key is generated on startup if not set, invalidating all tokens on restart
- **BookStack token in JWT** — the token is stored in the signed JWT payload (`bst` claim). The payload is base64-encoded but not encrypted (signed HS256). This is acceptable because: transport is HTTPS-only, Claude.ai stores tokens securely, and the BookStack token is a dedicated API credential — not a master password
- **Port binding** — bind to `127.0.0.1:3100:3100` in production so the port is only reachable via nginx, not directly from the internet

## License

MIT
