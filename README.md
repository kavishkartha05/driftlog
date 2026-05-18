# Driftlog

**Your codebase remembers.**

Driftlog is a Notion Worker (TypeScript, deployed via the `ntn` CLI) that autonomously builds a living architectural memory from GitHub pull requests. Every time a PR is opened, Claude analyzes the diff, writes a structured ADR to Notion, updates a living system architecture page, runs drift detection against prior decisions, and posts a comment back to the PR — no manual documentation required.

## How it works

```
GitHub PR → Notion Worker → Claude (claude-sonnet-4-6) → ADR DB + System Map → GitHub PR comment
```

1. A PR is opened on a connected GitHub repo
2. GitHub fires a webhook to the Notion Worker
3. The Worker fetches the diff via the GitHub API and sends it to Claude for structured analysis
4. Claude extracts: `system_affected`, `decision_made`, `rationale`, `decision_type`, `files_changed`
5. The Worker writes a new ADR entry to the Notion decisions database
6. The Worker upserts a living system architecture page in the System Map — one page per system, updated on every PR
7. Drift detection runs: the new decision is compared against the last 20 ADRs using a second Claude call. If the new change contradicts or reverses a prior architectural decision, a ⚠️ warning is added to the PR comment
8. A comment is posted to the GitHub PR with links to both the ADR page and the system architecture page

## What gets created

### ADR Database Entry

Each PR produces a structured page in the Notion decisions database:

| Field | Description |
|---|---|
| Decision | One-sentence description of the architectural decision (title) |
| System Affected | The module, service, or component impacted |
| Decision Type | One of `refactor`, `new_pattern`, `dependency_change`, `api_contract_change` |
| Rationale | Why the change was made, inferred from the diff and PR description |
| Files Changed | Most architecturally significant files |
| PR Title | Back-link label to the source PR |
| PR URL | Direct link to the GitHub PR |
| Health Score | Computed signal based on churn, drift, and refactor patterns |
| Drift Flag | Checkbox — checked if this decision contradicts a prior ADR |

### System Architecture Page

A living page per system in the Notion System Map, regenerated on every relevant PR. Claude synthesizes the full decision history for the system into four sections:

- **What this system does**
- **Key decisions made**
- **Emerging patterns**
- **Current architectural state**

The page is created on first encounter and updated in place on subsequent PRs. Notion becomes a self-writing architecture memory. Formatting uses rich Notion blocks: headings, bullets, inline code, bold text, and code blocks.

### Drift Detection

When a new PR lands, the Worker compares it against the last 20 ADRs for the same system. If Claude determines the new decision contradicts or reverses a prior one, the GitHub PR comment includes a `⚠️ Architectural Drift Detected` section explaining the conflict.

## Additional capabilities

### Weekly Digest (scheduled sync)

Runs automatically every Monday at 9am. Queries all ADRs from the last 7 days, calls Claude to produce a structured digest with four sections:

- **This Week in Architecture** — executive summary
- **Decision Summary** — table of all decisions
- **Key Themes** — `###` subheadings per theme
- **Watch List** — systems with multiple or conflicting changes

The digest is created as a new Notion page under the System Map.

Trigger manually at any time:

```bash
ntn workers exec weeklyDigest -d '{}'
```

### Generate Onboarding Doc (tool)

Reads the entire System Map and ADR database, calls Claude, and writes a complete new-engineer onboarding guide covering every system. Creates a Notion page with the result.

```bash
ntn workers exec generateOnboardingDoc -d '{}'
```

### Query Architecture (tool)

Takes a natural language question, queries the ADR database, and calls Claude to synthesize an answer from the full decision history. Callable via CLI or as a Notion Custom Agent tool.

```bash
ntn workers exec queryArchitecture -d '{"question": "Why did we move from REST to GraphQL?"}'
```

## Tech stack

- [Notion Workers](https://developers.notion.com/docs/notion-workers) — webhook runtime, sync engine, Notion API client (`ntn` CLI)
- [Anthropic Claude](https://anthropic.com) (`claude-sonnet-4-6`) — diff analysis, architecture synthesis, drift detection, digest and onboarding generation
- Notion API — ADR database writes, system page upserts, rich block formatting
- GitHub Webhooks — PR event triggers
- TypeScript (strict mode)
- React/Vite — companion frontend dashboard (separate repo, see below)

## Environment variables

```bash
GITHUB_TOKEN=           # GitHub PAT with repo scope (read diffs, post comments)
GITHUB_WEBHOOK_SECRET=  # Secret string used to validate webhook signatures
ANTHROPIC_API_KEY=      # Anthropic API key
NOTION_API_TOKEN=       # Notion internal integration token (starts with ntn_)
DATABASE_ID=            # ID of the Notion ADR database
SYSTEM_MAP_PAGE_ID=     # ID of the Notion System Map parent page
```

## Setup

### 1. Install the ntn CLI and log in

```bash
curl -fsSL https://ntn.dev | bash
ntn login
```

### 2. Clone the repo

```bash
git clone https://github.com/kavishkartha05/driftlog.git
cd driftlog
```

### 3. Create a Notion internal integration

Go to [notion.so/my-integrations](https://notion.so/my-integrations), create a new integration named `driftlog`, and copy the token (starts with `ntn_`). This becomes your `NOTION_API_TOKEN`.

### 4. Create the Notion structures

**Architecture Decisions database** — create a full-page database with exactly these properties:

| Property | Type | Options |
|---|---|---|
| Decision | Title | — |
| System Affected | Rich text | — |
| Decision Type | Select | `refactor`, `new_pattern`, `dependency_change`, `api_contract_change` |
| Rationale | Rich text | — |
| Files Changed | Rich text | — |
| PR Title | Rich text | — |
| PR URL | URL | — |
| Health Score | Number | — |
| Drift Flag | Checkbox | — |

**System Map page** — create a regular Notion page (not a database) to hold system architecture subpages.

### 5. Share both with the integration

Open the `...` menu on each page → **Connections** → select `driftlog`.

### 6. Copy the IDs

- `DATABASE_ID`: the 32-character hex string in the database URL (`notion.so/.../<DATABASE_ID>?v=...`)
- `SYSTEM_MAP_PAGE_ID`: the 32-character hex string in the System Map page URL

### 7. Create a GitHub PAT

Go to [github.com/settings/tokens](https://github.com/settings/tokens) → **Generate new token (classic)** → select the `repo` scope → name it `driftlog`. Copy the token.

### 8. Set all secrets

```bash
ntn workers secrets set GITHUB_TOKEN=<your token>
ntn workers secrets set GITHUB_WEBHOOK_SECRET=<choose a secret string>
ntn workers secrets set ANTHROPIC_API_KEY=<your key>
ntn workers secrets set NOTION_API_TOKEN=<your ntn_ token>
ntn workers secrets set DATABASE_ID=<your database id>
ntn workers secrets set SYSTEM_MAP_PAGE_ID=<your page id>
```

### 9. Deploy

```bash
ntn workers deploy
```

Copy the webhook URL from the deploy output. It looks like:

```
https://www.notion.so/webhooks/worker/<spaceId>/<workerId>/<id>/onPullRequest
```

You can also retrieve it later:

```bash
ntn workers webhooks list
```

### 10. Configure the GitHub webhook

In your target GitHub repo, go to **Settings → Webhooks → Add webhook**:

- **Payload URL**: the URL from the previous step
- **Content type**: `application/json`
- **Secret**: your `GITHUB_WEBHOOK_SECRET`
- **Events**: select **Let me select individual events** → check **Pull requests** only

### 11. Enable Workers in Notion

In your Notion workspace: **Settings → (workspace name) → Developer Platform** → enable **Workers** → set to **All workspace members**.

### 12. Test it

Open a pull request on the connected GitHub repo. Within 15–20 seconds, Driftlog should post a comment to the PR with links to the new ADR page and system architecture page.

## Manual triggers

```bash
# Generate this week's architecture digest immediately
ntn workers exec weeklyDigest -d '{}'

# Generate a new-engineer onboarding guide from the full ADR history
ntn workers exec generateOnboardingDoc -d '{}'

# Query the architectural history in natural language
ntn workers exec queryArchitecture -d '{"question": "your question here"}'
```

## Monitoring

```bash
ntn workers sync status          # live sync health (polls every 5s)
ntn workers runs list            # recent run history
ntn workers runs logs <runId>    # logs for a specific run
```

## Frontend dashboard

A companion React/Vite dashboard at [github.com/kavishkartha05/driftlog-frontend](https://github.com/kavishkartha05/driftlog-frontend) shows a live activity feed with health scores, drift warnings, and auto-refresh.

```bash
git clone https://github.com/kavishkartha05/driftlog-frontend.git
cd driftlog-frontend
# Add VITE_WEBHOOK_URL=<your worker webhook URL> to .env
npm install && npm run dev
```

---

Built at the **Notion Developer Platform Hackathon**, May 2026.
