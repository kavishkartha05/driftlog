import crypto from "crypto";
import { Worker, WebhookVerificationError } from "@notionhq/workers";
import * as Builder from "@notionhq/workers/builder";
import * as Schema from "@notionhq/workers/schema";
import { j } from "@notionhq/workers/schema-builder";
import type { BlockObjectRequest, Client, PageObjectResponse } from "@notionhq/client";

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
	driftResult: { has_drift: boolean; drift_summary: string; conflicting_decision: string },
	systemPageUrl: string,
): Promise<void> {
	const token = process.env.GITHUB_TOKEN;
	const lines = [
		"## Driftlog — Architectural Decision Recorded",
		"",
		`**Decision:** ${analysis.decision_made}`,
		`**Type:** \`${analysis.decision_type}\``,
		`**System Affected:** ${analysis.system_affected}`,
		`**Key Files:** ${analysis.files_changed.slice(0, 5).join(", ")}`,
		"",
		`[View full rationale in Notion](${notionUrl})`,
		`[View system architecture page in Notion](${systemPageUrl})`,
	];
	if (driftResult.has_drift) {
		lines.push(
			"",
			"⚠️ Architectural Drift Detected",
			driftResult.drift_summary,
			`Conflicts with prior decision: ${driftResult.conflicting_decision}`,
		);
	}
	const body = lines.join("\n");

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

	const apiToken = process.env.NOTION_API_TOKEN;
	if (!apiToken) throw new Error("NOTION_API_TOKEN not configured");

	const res = await fetch(`https://api.notion.com/v1/databases/${databaseId}/query`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiToken}`,
			"Notion-Version": "2022-06-28",
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			filter: {
				property: "System Affected",
				rich_text: { contains: systemAffected },
			},
			sorts: [{ timestamp: "created_time", direction: "ascending" }],
			page_size: 10,
		}),
	});

	if (!res.ok) {
		const errText = await res.text();
		throw new Error(`Notion API error ${res.status}: ${errText}`);
	}

	type PropSlice = Record<string, {
		title?: Array<{ plain_text: string }>;
		rich_text?: Array<{ plain_text: string }>;
		select?: { name: string } | null;
	}>;

	type NotionPage = { object: string; id: string; created_time: string; properties: PropSlice };
	const data = (await res.json()) as { results: Array<NotionPage> };

	return data.results.flatMap((result) => {
		if (result.object !== "page") return [];
		const props = result.properties;
		return [{
			decision_made: props["Decision"]?.title?.[0]?.plain_text ?? "",
			rationale: props["Rationale"]?.rich_text?.[0]?.plain_text ?? "",
			decision_type: props["Decision Type"]?.select?.name ?? "",
			created_time: result.created_time,
		}];
	});
}

async function queryRecentHistory(notion: Client): Promise<DecisionRecord[]> {
	const databaseId = process.env.DATABASE_ID;
	if (!databaseId) throw new Error("DATABASE_ID not configured");

	const apiToken = process.env.NOTION_API_TOKEN;
	if (!apiToken) throw new Error("NOTION_API_TOKEN not configured");

	const res = await fetch(`https://api.notion.com/v1/databases/${databaseId}/query`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiToken}`,
			"Notion-Version": "2022-06-28",
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			sorts: [{ timestamp: "created_time", direction: "descending" }],
			page_size: 20,
		}),
	});

	if (!res.ok) {
		const errText = await res.text();
		throw new Error(`Notion API error ${res.status}: ${errText}`);
	}

	type PropSlice = Record<string, {
		title?: Array<{ plain_text: string }>;
		rich_text?: Array<{ plain_text: string }>;
		select?: { name: string } | null;
	}>;

	type NotionPage = { object: string; id: string; created_time: string; properties: PropSlice };
	const data = (await res.json()) as { results: Array<NotionPage> };

	return data.results.flatMap((result) => {
		if (result.object !== "page") return [];
		const props = result.properties;
		return [{
			decision_made: props["Decision"]?.title?.[0]?.plain_text ?? "",
			rationale: props["Rationale"]?.rich_text?.[0]?.plain_text ?? "",
			decision_type: props["Decision Type"]?.select?.name ?? "",
			created_time: result.created_time,
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
## 🔍 What this system does
## 📋 Key decisions made
## 🔮 Emerging patterns
## 🏗️ Current architectural state

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
## 🔍 What this system does
## 📋 Key decisions made
## 🔮 Emerging patterns
## 🏗️ Current architectural state

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
// Markdown → Notion block parser
// ---------------------------------------------------------------------------

function plainText(text: string) {
	return [{ type: "text" as const, text: { content: text } }];
}

function parseInlineBold(text: string) {
	const result: Array<{ type: "text"; text: { content: string }; annotations?: { bold?: boolean; code?: boolean } }> = [];
	// Split on backticks first; odd-indexed segments are inline code spans.
	const codeSegments = text.split("`");
	for (let ci = 0; ci < codeSegments.length; ci++) {
		const segment = codeSegments[ci];
		if (ci % 2 === 1) {
			if (segment.length > 0) {
				result.push({ type: "text", text: { content: segment }, annotations: { code: true } });
			}
		} else {
			// Outside backticks — split on ** for bold.
			const boldParts = segment.split("**");
			for (let bi = 0; bi < boldParts.length; bi++) {
				const part = boldParts[bi];
				if (part.length > 0) {
					result.push(bi % 2 === 1
						? { type: "text", text: { content: part }, annotations: { bold: true } }
						: { type: "text", text: { content: part } },
					);
				}
			}
		}
	}
	return result;
}

function contentToBlocks(content: string): BlockObjectRequest[] {
	const blocks: BlockObjectRequest[] = [];
	let firstH2 = true;
	let inCodeBlock = false;
	const codeBuffer: string[] = [];
	let tableHeaderEmitted = false;

	for (const line of content.split("\n")) {
		if (line.startsWith("```")) {
			if (inCodeBlock) {
				blocks.push({
					type: "code",
					code: { rich_text: plainText(codeBuffer.join("\n")), language: "typescript" },
				});
				codeBuffer.length = 0;
			}
			inCodeBlock = !inCodeBlock;
		} else if (inCodeBlock) {
			codeBuffer.push(line);
		} else if (line.startsWith("|") && line.endsWith("|")) {
			if (/^[\|\-\s]+$/.test(line)) continue;
			const cells = line.slice(1, -1).split("|").map((c) => c.trim());
			if (!tableHeaderEmitted) {
				blocks.push({ type: "heading_3", heading_3: { rich_text: parseInlineBold(cells.join(" · ")) } });
				tableHeaderEmitted = true;
			} else {
				blocks.push({ type: "bulleted_list_item", bulleted_list_item: { rich_text: parseInlineBold(cells.join(" → ")) } });
			}
		} else {
			tableHeaderEmitted = false;
			if (line.startsWith("## ")) {
				if (!firstH2) blocks.push({ type: "divider", divider: {} });
				firstH2 = false;
				blocks.push({ type: "heading_2", heading_2: { rich_text: parseInlineBold(line.slice(3)) } });
			} else if (line.startsWith("### ")) {
				blocks.push({ type: "heading_3", heading_3: { rich_text: parseInlineBold(line.slice(4)) } });
			} else if (line.startsWith("**") && line.endsWith("**") && line.length > 4) {
				blocks.push({ type: "heading_3", heading_3: { rich_text: parseInlineBold(line.slice(2, -2)) } });
			} else if (line.startsWith("- ") || line.startsWith("* ")) {
				blocks.push({ type: "bulleted_list_item", bulleted_list_item: { rich_text: parseInlineBold(line.slice(2)) } });
			} else if (/^\d+\.\s/.test(line)) {
				blocks.push({ type: "numbered_list_item", numbered_list_item: { rich_text: parseInlineBold(line.replace(/^\d+\.\s/, "")) } });
			} else if (line.trim().length > 0) {
				blocks.push({ type: "paragraph", paragraph: { rich_text: parseInlineBold(line) } });
			}
		}
	}
	return blocks;
}

// ---------------------------------------------------------------------------
// System page upsert
// ---------------------------------------------------------------------------

async function upsertSystemPage(
	notion: Client,
	systemAffected: string,
	content: string,
): Promise<string> {
	const blocks = contentToBlocks(content);

	// Search for an existing page whose title exactly matches systemAffected
	const searchResult = await notion.search({
		query: systemAffected,
		filter: { property: "object", value: "page" },
		page_size: 10,
	});

	const existing = searchResult.results.find((result) => {
		if (result.object !== "page" || !("properties" in result)) return false;
		const page = result as PageObjectResponse;
		const titleProp = page.properties["title"] as unknown as {
			title: Array<{ plain_text: string }>;
		} | undefined;
		return titleProp?.title?.[0]?.plain_text === systemAffected;
	}) as PageObjectResponse | undefined;

	if (existing) {
		// Archive all existing child blocks
		const children = await notion.blocks.children.list({ block_id: existing.id });
		await Promise.all(
			children.results.map((block) => notion.blocks.delete({ block_id: block.id })),
		);

		// Append fresh content
		await notion.blocks.children.append({
			block_id: existing.id,
			children: blocks,
		});

		return `https://notion.so/${existing.id.replace(/-/g, "")}`;
	}

	// Create a new workspace-level page
	const page = await notion.pages.create({
		parent: { page_id: process.env.SYSTEM_MAP_PAGE_ID! },
		properties: {
			title: { title: [{ text: { content: systemAffected } }] },
		},
		children: blocks,
	});

	return `https://notion.so/${page.id.replace(/-/g, "")}`;
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

			const dedupRes = await fetch(`https://api.notion.com/v1/databases/${process.env.DATABASE_ID}/query`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${process.env.NOTION_API_TOKEN}`,
					"Notion-Version": "2022-06-28",
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					filter: { property: "PR URL", url: { equals: pr.html_url } },
				}),
			});
			const dedupData = (await dedupRes.json()) as { results: unknown[] };
			if (dedupData.results.length > 0) {
				console.log("[driftlog] PR already processed, skipping");
				continue;
			}

			console.log(`[driftlog] PR #${pr.number} (${action}): ${pr.title}`);

			const diff = await fetchPrDiff(repository.full_name, pr.number);
			const analysis = await analyzeWithAnthropic(diff, pr.title, pr.body ?? "");
			console.log("[driftlog] Analysis:", JSON.stringify(analysis, null, 2));

			const notionUrl = await createNotionPage(notion, analysis, pr.html_url, pr.title);
			console.log("[driftlog] Notion page created:", notionUrl);

			const history = await queryRecentHistory(notion);

			let driftResult: { has_drift: boolean; drift_summary: string; conflicting_decision: string };
			if (history.length > 0) {
				const driftRes = await fetch("https://api.anthropic.com/v1/messages", {
					method: "POST",
					headers: {
						"x-api-key": process.env.ANTHROPIC_API_KEY ?? "",
						"anthropic-version": "2023-06-01",
						"content-type": "application/json",
					},
					body: JSON.stringify({
						model: "claude-sonnet-4-6",
						max_tokens: 512,
						messages: [{
							role: "user",
							content: `You are an architectural consistency checker. Given a new decision and the history of past decisions for the same system, determine if the new decision contradicts, reverses, or creates tension with any previous decision. Return ONLY valid JSON with no markdown fences with these exact fields: has_drift (boolean), drift_summary (one sentence describing the conflict if has_drift is true, empty string if false), conflicting_decision (the past decision text it conflicts with, empty string if no drift). New decision: ${analysis.decision_made}. Past decisions: ${history.map((h) => h.decision_made).join("\n")}`,
						}],
					}),
				});
				if (!driftRes.ok) throw new Error(`Anthropic drift check error ${driftRes.status}: ${await driftRes.text()}`);
				const driftData = (await driftRes.json()) as { content: Array<{ type: string; text: string }> };
				const driftText = driftData.content.find((c) => c.type === "text")?.text;
				if (!driftText) throw new Error("Anthropic returned no text for drift check");
				driftResult = JSON.parse(driftText) as { has_drift: boolean; drift_summary: string; conflicting_decision: string };
				if (driftResult.has_drift) {
					console.log("[driftlog] Drift detected:", driftResult.drift_summary);
				}
			} else {
				driftResult = { has_drift: false, drift_summary: "", conflicting_decision: "" };
			}

			const systemPageContent = await generateSystemPage(analysis.system_affected, history, analysis);
			const systemPageUrl = await upsertSystemPage(notion, analysis.system_affected, systemPageContent);
			console.log("[driftlog] System page upserted:", systemPageUrl);

			await postGitHubComment(repository.full_name, pr.number, notionUrl, analysis, driftResult, systemPageUrl);
			console.log("[driftlog] GitHub comment posted");
		}
	},
});

// ---------------------------------------------------------------------------
// Architecture query tool
// ---------------------------------------------------------------------------

worker.tool("queryArchitecture", {
	title: "Query Architecture Decisions",
	description: "Ask a natural language question about the architectural decisions recorded in this codebase. Returns a synthesized answer based on the full ADR history.",
	schema: j.object({
		question: j.string().describe("The natural language question to ask about the codebase architecture"),
	}),
	execute: async ({ question }, { notion: _notion }) => {
		const res = await fetch(`https://api.notion.com/v1/databases/${process.env.DATABASE_ID}/query`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${process.env.NOTION_API_TOKEN}`,
				"Notion-Version": "2022-06-28",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				sorts: [{ timestamp: "created_time", direction: "ascending" }],
				page_size: 50,
			}),
		});

		if (!res.ok) throw new Error(`Notion API error ${res.status}: ${await res.text()}`);

		type PropSlice = Record<string, {
			title?: Array<{ plain_text: string }>;
			rich_text?: Array<{ plain_text: string }>;
			select?: { name: string } | null;
		}>;
		type NotionPage = { object: string; created_time: string; properties: PropSlice };
		const data = (await res.json()) as { results: Array<NotionPage> };

		const adrs = data.results.flatMap((result) => {
			if (result.object !== "page") return [];
			const props = result.properties;
			return [{
				decision_made: props["Decision"]?.title?.[0]?.plain_text ?? "",
				system_affected: props["System Affected"]?.rich_text?.[0]?.plain_text ?? "",
				decision_type: props["Decision Type"]?.select?.name ?? "",
				created_time: result.created_time,
			}];
		});

		if (adrs.length === 0) return "No architectural decisions have been recorded yet.";

		console.log("[driftlog:tool] Fetched ADR count:", adrs.length);

		const formattedAdrs = adrs.map((adr, i) =>
			`${i + 1}. ${adr.created_time.slice(0, 10)} | ${adr.system_affected} | ${adr.decision_type} | ${adr.decision_made}`
		).join("\n");

		const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
			method: "POST",
			headers: {
				"x-api-key": process.env.ANTHROPIC_API_KEY ?? "",
				"anthropic-version": "2023-06-01",
				"content-type": "application/json",
			},
			body: JSON.stringify({
				model: "claude-sonnet-4-6",
				max_tokens: 1024,
				messages: [{
					role: "user",
					content: `You are an architectural knowledge assistant for a software team. Below is the complete history of architectural decisions recorded for this codebase. Answer the following question based on these decisions. Be specific, cite relevant decisions by number, and synthesize insights across systems where relevant.

Architectural decisions:
${formattedAdrs}

Question: ${question}`,
				}],
			}),
		});

		if (!claudeRes.ok) throw new Error(`Anthropic API error ${claudeRes.status}: ${await claudeRes.text()}`);

		const claudeData = (await claudeRes.json()) as { content: Array<{ type: string; text: string }> };
		const answer = claudeData.content.find((c) => c.type === "text")?.text;
		if (!answer) throw new Error("Anthropic returned no text content");
		return answer;
	},
});

// ---------------------------------------------------------------------------
// Onboarding doc generator tool
// ---------------------------------------------------------------------------

worker.tool("generateOnboardingDoc", {
	title: "Generate Onboarding Guide",
	description: "Synthesizes all recorded architectural decisions into a new engineer onboarding guide and saves it as a Notion page",
	schema: j.object({}),
	execute: async (_args, { notion }) => {
		const res = await fetch(`https://api.notion.com/v1/databases/${process.env.DATABASE_ID}/query`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${process.env.NOTION_API_TOKEN}`,
				"Notion-Version": "2022-06-28",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				sorts: [{ timestamp: "created_time", direction: "ascending" }],
				page_size: 20,
			}),
		});

		if (!res.ok) throw new Error(`Notion API error ${res.status}: ${await res.text()}`);

		type PropSlice = Record<string, {
			title?: Array<{ plain_text: string }>;
			rich_text?: Array<{ plain_text: string }>;
			select?: { name: string } | null;
		}>;
		type NotionPage = { object: string; created_time: string; properties: PropSlice };
		const data = (await res.json()) as { results: Array<NotionPage> };

		const adrs = data.results.flatMap((result) => {
			if (result.object !== "page") return [];
			const props = result.properties;
			return [{
				decision_made: props["Decision"]?.title?.[0]?.plain_text ?? "",
				system_affected: props["System Affected"]?.rich_text?.[0]?.plain_text ?? "",
				rationale: props["Rationale"]?.rich_text?.[0]?.plain_text ?? "",
				decision_type: props["Decision Type"]?.select?.name ?? "",
				created_time: result.created_time,
			}];
		});

		if (adrs.length === 0) return "No architectural decisions recorded yet.";

		console.log("[driftlog:onboarding] Fetched ADR count:", adrs.length);

		const bySystem = new Map<string, typeof adrs>();
		for (const adr of adrs) {
			const existing = bySystem.get(adr.system_affected);
			if (existing) {
				existing.push(adr);
			} else {
				bySystem.set(adr.system_affected, [adr]);
			}
		}

		const formattedSections = Array.from(bySystem.entries()).map(([system, decisions]) => {
			const bullets = decisions.map((d) =>
				`- [${d.created_time.slice(0, 10)}] (${d.decision_type}) ${d.decision_made}\n  Rationale: ${d.rationale}`
			).join("\n");
			return `### ${system}\n${bullets}`;
		}).join("\n\n");

		const apiKey = process.env.ANTHROPIC_API_KEY;
		if (!apiKey) throw new Error("ANTHROPIC_API_KEY not configured");

		const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
			method: "POST",
			headers: {
				"x-api-key": apiKey,
				"anthropic-version": "2023-06-01",
				"content-type": "application/json",
			},
			body: JSON.stringify({
				model: "claude-sonnet-4-6",
				max_tokens: 2048,
				messages: [{
					role: "user",
					content: `You are a staff engineer writing a new hire onboarding guide. Based on the architectural decisions below grouped by system, write a comprehensive guide for someone joining this engineering team today. Use exactly these sections in order: ## 👋 Welcome to the Codebase, ## 🗺️ System Overview, ## 🔑 Key Systems (one ### subsection per system), ## 🏗️ How It All Fits Together, ## ⚠️ Things to Know Before You Touch Anything. Be specific, practical and technical.

${formattedSections}`,
				}],
			}),
		});

		if (!claudeRes.ok) throw new Error(`Anthropic API error ${claudeRes.status}: ${await claudeRes.text()}`);

		const claudeData = (await claudeRes.json()) as { content: Array<{ type: string; text: string }> };
		const content = claudeData.content.find((c) => c.type === "text")?.text;
		if (!content) throw new Error("Anthropic returned no text content");

		const blocks = contentToBlocks(content);

		const searchResult = await notion.search({
			query: "New Engineer Onboarding Guide",
			filter: { property: "object", value: "page" },
			page_size: 5,
		});

		const existing = searchResult.results.find((result) => {
			if (result.object !== "page" || !("properties" in result)) return false;
			const page = result as PageObjectResponse;
			const titleProp = page.properties["title"] as unknown as {
				title: Array<{ plain_text: string }>;
			} | undefined;
			return titleProp?.title?.[0]?.plain_text?.startsWith("New Engineer Onboarding Guide");
		}) as PageObjectResponse | undefined;

		let pageId: string;

		if (existing) {
			const children = await notion.blocks.children.list({ block_id: existing.id });
			await Promise.all(
				children.results.map((block) => notion.blocks.delete({ block_id: block.id })),
			);
			await notion.blocks.children.append({ block_id: existing.id, children: blocks });
			pageId = existing.id;
		} else {
			const today = new Date().toISOString().slice(0, 10);
			const page = await notion.pages.create({
				parent: { page_id: process.env.SYSTEM_MAP_PAGE_ID! },
				properties: {
					title: { title: [{ text: { content: `New Engineer Onboarding Guide — ${today}` } }] },
				},
				children: blocks,
			});
			pageId = page.id;
		}

		return `https://notion.so/${pageId.replace(/-/g, "")}`;
	},
});

// ---------------------------------------------------------------------------
// Weekly digest sync
// ---------------------------------------------------------------------------

const digestLog = worker.database("digestLog", {
	type: "managed",
	initialTitle: "Driftlog — Weekly Digests",
	primaryKeyProperty: "Week",
	schema: {
		properties: {
			Week: Schema.title(),
			"Digest URL": Schema.url(),
		},
	},
});

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

// Runs every 7 days. The SDK supports interval strings only ("7d") — cron
// expressions ("0 9 * * 1") are not yet supported.
worker.sync("weeklyDigest", {
	database: digestLog,
	mode: "incremental",
	schedule: "7d",
	execute: async (_state, { notion }) => {
		const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

		// Fetch ADRs created in the last 7 days.
		const adrRes = await fetch(`https://api.notion.com/v1/databases/${process.env.DATABASE_ID}/query`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${process.env.NOTION_API_TOKEN}`,
				"Notion-Version": "2022-06-28",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				filter: { timestamp: "created_time", created_time: { on_or_after: sevenDaysAgo } },
			}),
		});

		if (!adrRes.ok) throw new Error(`Notion API error ${adrRes.status}: ${await adrRes.text()}`);

		type AdrPage = {
			created_time: string;
			properties: Record<string, {
				title?: Array<{ plain_text: string }>;
				rich_text?: Array<{ plain_text: string }>;
				select?: { name: string } | null;
			}>;
		};
		const adrData = (await adrRes.json()) as { results: Array<AdrPage> };

		if (adrData.results.length === 0) {
			console.log("[driftlog] No ADRs this week, skipping digest");
			return { changes: [], hasMore: false };
		}

		const decisionList = adrData.results.map((p) => {
			const props = p.properties;
			return `- [${p.created_time.slice(0, 10)}] (${props["Decision Type"]?.select?.name ?? "unknown"}) ${props["Decision"]?.title?.[0]?.plain_text ?? ""} — ${props["System Affected"]?.rich_text?.[0]?.plain_text ?? ""}`;
		}).join("\n");

		// Generate digest with Claude.
		const apiKey = process.env.ANTHROPIC_API_KEY;
		if (!apiKey) throw new Error("ANTHROPIC_API_KEY not configured");

		const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
			method: "POST",
			headers: {
				"x-api-key": apiKey,
				"anthropic-version": "2023-06-01",
				"content-type": "application/json",
			},
			body: JSON.stringify({
				model: "claude-sonnet-4-6",
				max_tokens: 2048,
				messages: [{
					role: "user",
					content: `You are a staff engineer writing a weekly architecture digest.

Here are the architectural decisions recorded this week:
${decisionList}

Write it using exactly these four sections:

Section 1 — '## 🗓️ This Week in Architecture': write 2-3 sentences summarizing the week's architectural activity.

Section 2 — '## 📊 Decision Summary': write a markdown table with these exact columns: # | Date | System | Type | Decision. One row per ADR, no extra commentary.

Section 3 — '## 🔍 Key Themes': write 3-4 themes. Each theme as a ### heading followed by 2-3 sentences.

Section 4 — '## ⚠️ Watch List': write a markdown table with columns: System | Changes This Week | Concern. Only include systems with 2 or more changes or notable risks. After the table, for each watched system write a code block showing the files changed this week as a directory tree, with a one-line description after each file using a left arrow comment.

Use markdown throughout. Be specific and technical. Do not add any sections beyond these four.`,
				}],
			}),
		});

		if (!claudeRes.ok) throw new Error(`Anthropic API error ${claudeRes.status}: ${await claudeRes.text()}`);

		const claudeData = (await claudeRes.json()) as { content: Array<{ type: string; text: string }> };
		const digestContent = claudeData.content.find((c) => c.type === "text")?.text;
		if (!digestContent) throw new Error("Anthropic returned no text content");

		// Create the digest page under SYSTEM_MAP_PAGE_ID.
		const now = new Date();
		const weekTitle = `Week of ${MONTHS[now.getMonth()]} ${now.getDate()} ${now.getFullYear()}`;

		const digestPage = await notion.pages.create({
			parent: { page_id: process.env.SYSTEM_MAP_PAGE_ID! },
			properties: {
				title: { title: [{ text: { content: weekTitle } }] },
			},
			children: contentToBlocks(digestContent),
		});

		const digestUrl = `https://notion.so/${digestPage.id.replace(/-/g, "")}`;
		console.log("[driftlog] Digest page created:", digestUrl);

		return {
			changes: [{
				type: "upsert" as const,
				key: weekTitle,
				properties: {
					Week: Builder.title(weekTitle),
					"Digest URL": Builder.url(digestUrl),
				},
			}],
			hasMore: false,
		};
	},
});
