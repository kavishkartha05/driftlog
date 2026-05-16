import crypto from "crypto";
import { Worker, WebhookVerificationError } from "@notionhq/workers";
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
	systemPageUrl: string,
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
		`[View system architecture page in Notion](${systemPageUrl})`,
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
// System page upsert
// ---------------------------------------------------------------------------

async function upsertSystemPage(
	notion: Client,
	systemAffected: string,
	content: string,
): Promise<string> {
	const plainText = (text: string) => [{ type: "text" as const, text: { content: text } }];

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
			// Skip separator rows (contain only |, -, and spaces).
			if (/^[\|\-\s]+$/.test(line)) {
				continue;
			}
			const cells = line.slice(1, -1).split("|").map((c) => c.trim());
			if (!tableHeaderEmitted) {
				blocks.push({ type: "heading_3", heading_3: { rich_text: parseInlineBold(cells.join(" · ")) } });
				tableHeaderEmitted = true;
			} else {
				blocks.push({ type: "bulleted_list_item", bulleted_list_item: { rich_text: parseInlineBold(cells.join(" → ")) } });
			}
		} else {
			// Any non-table line resets the table header flag for the next table.
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

			const history = await querySystemHistory(notion, analysis.system_affected);
			const systemPageContent = await generateSystemPage(analysis.system_affected, history, analysis);
			const systemPageUrl = await upsertSystemPage(notion, analysis.system_affected, systemPageContent);
			console.log("[driftlog] System page upserted:", systemPageUrl);

			await postGitHubComment(repository.full_name, pr.number, notionUrl, analysis, systemPageUrl);
			console.log("[driftlog] GitHub comment posted");
		}
	},
});
