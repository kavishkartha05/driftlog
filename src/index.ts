import crypto from "crypto";
import { Worker, WebhookVerificationError } from "@notionhq/workers";
import type { Client, PageObjectResponse } from "@notionhq/client";

const worker = new Worker();
export default worker;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PrPayload {
	action: string;
	pull_request: {
		number: number;
		title: string;
		html_url: string;
		body: string | null;
	};
	repository: { full_name: string };
}

interface ArchitecturalAnalysis {
	system_affected: string;
	decision_made: string;
	rationale: string;
	decision_type: "refactor" | "new_pattern" | "dependency_change" | "api_contract_change";
	files_changed: string[];
}

// ---------------------------------------------------------------------------
// GitHub signature verification
// ---------------------------------------------------------------------------

function verifyGitHubSignature(rawBody: string, headers: Record<string, string>): void {
	const secret = process.env.GITHUB_WEBHOOK_SECRET;
	if (!secret) throw new WebhookVerificationError("GITHUB_WEBHOOK_SECRET not configured");

	const signature = headers["x-hub-signature-256"];
	if (!signature?.startsWith("sha256=")) {
		throw new WebhookVerificationError("Missing or malformed x-hub-signature-256 header");
	}

	const expected = `sha256=${crypto.createHmac("sha256", secret).update(rawBody).digest("hex")}`;

	if (
		signature.length !== expected.length ||
		!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
	) {
		throw new WebhookVerificationError("GitHub signature mismatch");
	}
}

// ---------------------------------------------------------------------------
// GitHub API helpers
// ---------------------------------------------------------------------------

async function fetchPrDiff(repoFullName: string, prNumber: number): Promise<string> {
	const token = process.env.GITHUB_TOKEN;
	const res = await fetch(`https://api.github.com/repos/${repoFullName}/pulls/${prNumber}`, {
		headers: {
			Authorization: `Bearer ${token}`,
			Accept: "application/vnd.github.v3.diff",
			"User-Agent": "driftlog-worker",
		},
	});
	if (!res.ok) throw new Error(`GitHub diff fetch failed: ${res.status} ${res.statusText}`);
	const diff = await res.text();
	// Cap at 20k chars to stay within model context limits
	return diff.slice(0, 20_000);
}

async function postGitHubComment(
	repoFullName: string,
	prNumber: number,
	notionUrl: string,
	analysis: ArchitecturalAnalysis,
): Promise<void> {
	const token = process.env.GITHUB_TOKEN;
	const body = [
		"## Driftlog — Architectural Decision Recorded",
		"",
		`**Decision:** ${analysis.decision_made}`,
		`**Type:** \`${analysis.decision_type}\``,
		`**System Affected:** ${analysis.system_affected}`,
		`**Key Files:** ${analysis.files_changed.slice(0, 5).join(", ")}`,
		"",
		`[View full rationale in Notion](${notionUrl})`,
	].join("\n");

	const res = await fetch(`https://api.github.com/repos/${repoFullName}/issues/${prNumber}/comments`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			Accept: "application/vnd.github.v3+json",
			"User-Agent": "driftlog-worker",
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ body }),
	});
	if (!res.ok) throw new Error(`GitHub comment POST failed: ${res.status} ${res.statusText}`);
}

// ---------------------------------------------------------------------------
// Anthropic analysis
// ---------------------------------------------------------------------------

async function analyzeWithAnthropic(
	diff: string,
	prTitle: string,
	prBody: string,
): Promise<ArchitecturalAnalysis> {
	const apiKey = process.env.ANTHROPIC_API_KEY;
	if (!apiKey) throw new Error("ANTHROPIC_API_KEY not configured");

	const res = await fetch("https://api.anthropic.com/v1/messages", {
		method: "POST",
		headers: {
			"x-api-key": apiKey,
			"anthropic-version": "2023-06-01",
			"content-type": "application/json",
		},
		body: JSON.stringify({
			model: "claude-sonnet-4-6",
			max_tokens: 1024,
			messages: [
				{
					role: "user",
					content: `You are an architectural decision analyst. Analyze this GitHub PR and extract the core architectural decision it represents.

PR Title: ${prTitle}
PR Description: ${prBody || "(none provided)"}

Diff (may be truncated):
${diff}

Return ONLY a valid JSON object — no markdown fences, no explanation — with exactly these fields:
{
  "system_affected": "the module, service, layer, or component most impacted",
  "decision_made": "one sentence describing the architectural decision",
  "rationale": "why this change was made (infer from code and context if not stated explicitly)",
  "decision_type": "one of: refactor | new_pattern | dependency_change | api_contract_change",
  "files_changed": ["array of the most architecturally significant file paths changed"]
}`,
				},
			],
		}),
	});

	if (!res.ok) {
		const errText = await res.text();
		throw new Error(`Anthropic API error ${res.status}: ${errText}`);
	}

	const data = (await res.json()) as { content: Array<{ type: string; text: string }> };
	const text = data.content.find((c) => c.type === "text")?.text;
	if (!text) throw new Error("Anthropic returned no text content");

	try {
		return JSON.parse(text) as ArchitecturalAnalysis;
	} catch {
		throw new Error(`Anthropic response was not valid JSON: ${text.slice(0, 200)}`);
	}
}

// ---------------------------------------------------------------------------
// Notion page creation
// ---------------------------------------------------------------------------

async function createNotionPage(
	notion: Client,
	analysis: ArchitecturalAnalysis,
	prUrl: string,
	prTitle: string,
): Promise<string> {
	const databaseId = process.env.DATABASE_ID;
	if (!databaseId) throw new Error("NOTION_DATABASE_ID not configured");

	const page = await notion.pages.create({
		parent: { database_id: databaseId },
		properties: {
			// "Decision" must be the title property of the database
			Decision: {
				title: [{ text: { content: analysis.decision_made } }],
			},
			"System Affected": {
				rich_text: [{ text: { content: analysis.system_affected } }],
			},
			"Decision Type": {
				select: { name: analysis.decision_type },
			},
			Rationale: {
				rich_text: [{ text: { content: analysis.rationale } }],
			},
			"Files Changed": {
				rich_text: [{ text: { content: analysis.files_changed.join(", ") } }],
			},
			"PR Title": {
				rich_text: [{ text: { content: prTitle } }],
			},
			"PR URL": {
				url: prUrl,
			},
		},
	});

	// Notion page URLs use the ID without dashes
	return `https://notion.so/${page.id.replace(/-/g, "")}`;
}

// ---------------------------------------------------------------------------
// Notion history query
// ---------------------------------------------------------------------------

interface DecisionRecord {
	decision_made: string;
	rationale: string;
	decision_type: string;
	created_time: string;
}

async function querySystemHistory(notion: Client, systemAffected: string): Promise<DecisionRecord[]> {
	const databaseId = process.env.DATABASE_ID;
	if (!databaseId) throw new Error("DATABASE_ID not configured");

	const response = await notion.dataSources.query({
		data_source_id: databaseId,
		filter: {
			property: "System Affected",
			rich_text: { contains: systemAffected },
		},
		sorts: [{ timestamp: "created_time", direction: "ascending" }],
		page_size: 10,
	});

	type PropSlice = Record<string, {
		title?: Array<{ plain_text: string }>;
		rich_text?: Array<{ plain_text: string }>;
		select?: { name: string } | null;
	}>;

	return response.results.flatMap((result) => {
		if (result.object !== "page" || !("created_time" in result)) return [];
		const page = result as PageObjectResponse;
		const props = page.properties as unknown as PropSlice;
		return [{
			decision_made: props["Decision"]?.title?.[0]?.plain_text ?? "",
			rationale: props["Rationale"]?.rich_text?.[0]?.plain_text ?? "",
			decision_type: props["Decision Type"]?.select?.name ?? "",
			created_time: page.created_time,
		}];
	});
}

// ---------------------------------------------------------------------------
// System architecture page generation
// ---------------------------------------------------------------------------

async function generateSystemPage(
	systemAffected: string,
	history: DecisionRecord[],
	latestAnalysis: ArchitecturalAnalysis,
): Promise<string> {
	const apiKey = process.env.ANTHROPIC_API_KEY;
	if (!apiKey) throw new Error("ANTHROPIC_API_KEY not configured");

	const historySection = history.length > 0
		? history.map((r, i) =>
			`${i + 1}. [${r.created_time.slice(0, 10)}] (${r.decision_type}) ${r.decision_made}\n   Rationale: ${r.rationale}`
		).join("\n")
		: "(no prior decisions recorded)";

	const prompt = history.length === 0
		? `You are a software architect. Write a rich system architecture page for the system "${systemAffected}" based solely on the following decision.

Latest decision:
- Type: ${latestAnalysis.decision_type}
- Decision: ${latestAnalysis.decision_made}
- Rationale: ${latestAnalysis.rationale}
- Files: ${latestAnalysis.files_changed.join(", ")}

Write the page with exactly these four sections in order:
## What this system does
## Key decisions made
## Emerging patterns
## Current architectural state

Use markdown. Be specific and technical. Do not add any sections beyond the four listed.`
		: `You are a software architect. Write a rich system architecture page for the system "${systemAffected}" based on its full decision history and the latest change.

Decision history (oldest to newest):
${historySection}

Latest decision:
- Type: ${latestAnalysis.decision_type}
- Decision: ${latestAnalysis.decision_made}
- Rationale: ${latestAnalysis.rationale}
- Files: ${latestAnalysis.files_changed.join(", ")}

Write the page with exactly these four sections in order:
## What this system does
## Key decisions made
## Emerging patterns
## Current architectural state

Use markdown. Be specific and technical. Synthesize patterns across the full history. Do not add any sections beyond the four listed.`;

	const res = await fetch("https://api.anthropic.com/v1/messages", {
		method: "POST",
		headers: {
			"x-api-key": apiKey,
			"anthropic-version": "2023-06-01",
			"content-type": "application/json",
		},
		body: JSON.stringify({
			model: "claude-sonnet-4-6",
			max_tokens: 2048,
			messages: [{ role: "user", content: prompt }],
		}),
	});

	if (!res.ok) {
		const errText = await res.text();
		throw new Error(`Anthropic API error ${res.status}: ${errText}`);
	}

	const data = (await res.json()) as { content: Array<{ type: string; text: string }> };
	const text = data.content.find((c) => c.type === "text")?.text;
	if (!text) throw new Error("Anthropic returned no text content");
	return text;
}

// ---------------------------------------------------------------------------
// Webhook handler
// ---------------------------------------------------------------------------

const HANDLED_ACTIONS = new Set(["opened", "synchronize", "reopened"]);

worker.webhook("onPullRequest", {
	title: "GitHub PR Webhook",
	description: "Analyzes PR diffs with Claude and records architectural decisions in Notion",
	execute: async (events, { notion }) => {
		for (const event of events) {
			verifyGitHubSignature(event.rawBody, event.headers);

			// Only handle pull_request events; ignore ping, push, etc.
			if (event.headers["x-github-event"] !== "pull_request") continue;

			const { action, pull_request: pr, repository } = event.body as unknown as PrPayload;
			if (!HANDLED_ACTIONS.has(action)) continue;

			console.log(`[driftlog] PR #${pr.number} (${action}): ${pr.title}`);

			const diff = await fetchPrDiff(repository.full_name, pr.number);
			const analysis = await analyzeWithAnthropic(diff, pr.title, pr.body ?? "");
			console.log("[driftlog] Analysis:", JSON.stringify(analysis, null, 2));

			const notionUrl = await createNotionPage(notion, analysis, pr.html_url, pr.title);
			console.log("[driftlog] Notion page created:", notionUrl);

			await postGitHubComment(repository.full_name, pr.number, notionUrl, analysis);
			console.log("[driftlog] GitHub comment posted");
		}
	},
});
