# Driftlog

**Your codebase remembers.**

Driftlog is a Notion Worker that autonomously builds a living architecture knowledge base from GitHub pull requests. Every time a PR lands, Claude analyzes the diff, extracts the architectural decision, and writes it to Notion — no manual documentation required.

## How it works

```
GitHub PR → Notion Worker → Claude (Anthropic) → Notion DB + System Map → GitHub PR Comment
```

1. A PR is opened, synchronized, or reopened on GitHub
2. GitHub fires a webhook to the Notion Worker
3. The Worker fetches the diff and sends it to Claude (`claude-sonnet-4-6`)
4. Claude returns a structured architectural decision (system affected, decision made, rationale, type, files)
5. The Worker writes an ADR entry to the Notion decisions database
6. The Worker queries prior decisions for the same system, then generates or updates a system architecture page
7. A comment is posted on the PR with links to both Notion pages

## What gets created

**ADR Database Entry**

A structured page in your Notion decisions database with:
- `Decision` — one-sentence description of the architectural decision
- `System Affected` — the module, service, or component impacted
- `Decision Type` — one of `refactor`, `new_pattern`, `dependency_change`, `api_contract_change`
- `Rationale` — why the change was made (inferred from diff and PR description)
- `Files Changed` — the most architecturally significant files
- `PR Title` and `PR URL` — back-link to the source PR

**System Architecture Page**

A living page in your Notion System Map, regenerated on every relevant PR. Claude synthesizes the full decision history for that system into four sections:

- 🔍 **What this system does**
- 📋 **Key decisions made**
- 🔮 **Emerging patterns**
- 🏗️ **Current architectural state**

The page is created on first encounter and updated in place on subsequent PRs. Notion becomes a self-writing architecture memory.

## Tech stack

- [Notion Workers](https://developers.notion.com/docs/notion-workers) — webhook runtime and Notion API client
- [Anthropic Claude](https://anthropic.com) (`claude-sonnet-4-6`) — diff analysis and architecture page generation
- Notion API — ADR database writes, system page upserts
- GitHub Webhooks — PR event triggers
- TypeScript (strict)

## Setup

### 1. Notion

Create an [internal integration](https://www.notion.so/profile/integrations/internal) and grant it access to:
- Your decisions database (copy its ID → `DATABASE_ID`)
- Your System Map page (copy its ID → `SYSTEM_MAP_PAGE_ID`)

The decisions database needs these properties:

| Property | Type |
|---|---|
| Decision | Title |
| System Affected | Rich text |
| Decision Type | Select (`refactor`, `new_pattern`, `dependency_change`, `api_contract_change`) |
| Rationale | Rich text |
| Files Changed | Rich text |
| PR Title | Rich text |
| PR URL | URL |

### 2. Environment variables

```bash
GITHUB_TOKEN=           # Personal access token with repo scope (read diff, post comments)
GITHUB_WEBHOOK_SECRET=  # Secret set when configuring the GitHub webhook
ANTHROPIC_API_KEY=      # Anthropic API key
NOTION_API_TOKEN=       # Internal integration token from step 1
DATABASE_ID=            # Notion decisions database ID
SYSTEM_MAP_PAGE_ID=     # Notion page ID where system architecture pages are created
```

Push to the deployed worker:

```bash
ntn workers env push
```

### 3. Deploy

```bash
ntn workers deploy
ntn workers webhooks list  # copy the webhook URL
```

Configure the webhook in your GitHub repo under **Settings → Webhooks**:
- **Payload URL**: the URL from `ntn workers webhooks list`
- **Content type**: `application/json`
- **Events**: Pull requests

---

Built at the **Notion Developer Platform Hackathon**, May 2026.
