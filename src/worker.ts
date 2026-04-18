import { DurableObject } from "cloudflare:workers";
import { handle } from "@astrojs/cloudflare/handler";
import { GoogleGenAI } from "@google/genai";
import systemInstructionsRaw from "@/system-instructions.md?raw";

const WIB_OFFSET_HOURS = 7;
const MAX_GENERATION_ATTEMPTS = 5;
const RECENT_TITLE_WINDOW = 12;
const RECENT_CONTENT_WINDOW = 50;
const NEAR_DUPLICATE_THRESHOLD = 0.84;
const MAX_TITLE_LENGTH = 60;
const MAX_DESCRIPTION_LENGTH = 180;
const MIN_ARTICLE_WORDS = 1500;
const MAX_ARTICLE_WORDS = 2000;
const TARGET_ARTICLE_WORDS = 1700;
const MAX_CONTINUATION_ATTEMPTS = 3;
const LOCAL_DEV_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1"]);

let hasAttemptedDevStartupGeneration = false;
let isAttemptingDevStartupGeneration = false;

interface WorkerEnv {
	ASSETS: Fetcher;
	D1: D1Database;
	KV: KVNamespace;
	BLOG_ORCHESTRATOR: DurableObjectNamespace<BlogGenerationOrchestrator>;
	GOOGLE_API_KEY: string;
	GOOGLE_MODEL_NAME: string;
	CRON_SECRET?: string;
	AUTO_GENERATE_ON_DEV_START: string;
}

interface RunRequest {
	scheduledTime: number;
	cron?: string;
	source: "scheduled" | "manual";
}

interface GeneratedPayload {
	title: string;
	description: string;
	tags: string[];
	mdxBody: string;
}

interface PreparedPost {
	id: string;
	slug: string;
	title: string;
	normalizedTitle: string;
	description: string;
	tags: string[];
	mdxBody: string;
	wordCount: number;
	canonicalContent: string;
	contentHash: string;
	publishAt: number;
	createdAt: number;
	updatedAt: number;
	modelName: string;
}

interface DuplicateCheckResult {
	isDuplicate: boolean;
	reason?: string;
	similarity?: number;
}

interface RecentTitleRow {
	title: string;
	description: string;
}

interface RecentCanonicalRow {
	id: string;
	title: string;
	canonical_content: string;
}

interface ExistingSlugRow {
	slug: string;
}

interface ExistingTitleRow {
	id: string;
}

interface ExistingHashRow {
	id: string;
}

interface RunResult {
	status: "published" | "skipped" | "failed";
	postId?: string;
	slug?: string;
	wordCount?: number;
	reason?: string;
	attempt?: number;
}

function responseJson(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data, null, 2), {
		headers: {
			"content-type": "application/json; charset=utf-8",
		},
		status,
	});
}

function parseBooleanEnv(value?: string): boolean | undefined {
	if (!value) {
		return undefined;
	}
	const normalized = value.trim().toLowerCase();
	if (["1", "true", "yes", "y", "on"].includes(normalized)) {
		return true;
	}
	if (["0", "false", "no", "n", "off"].includes(normalized)) {
		return false;
	}
	return undefined;
}

function shouldAttemptDevStartupGeneration(url: URL, env: WorkerEnv): boolean {
	if (hasAttemptedDevStartupGeneration || isAttemptingDevStartupGeneration) {
		return false;
	}
	if (!LOCAL_DEV_HOSTS.has(url.hostname)) {
		return false;
	}
	const configured = parseBooleanEnv(env.AUTO_GENERATE_ON_DEV_START);
	if (configured === false) {
		return false;
	}
	return true;
}

async function tryDevStartupGeneration(env: WorkerEnv): Promise<boolean> {
	try {
		const response = await triggerOrchestrator(env, {
			scheduledTime: Date.now(),
			cron: "dev-startup",
			source: "manual",
		});
		const body = await response.text();
		console.log(`[dev-startup-generate] status=${response.status} body=${body}`);
		if (!response.ok) {
			return false;
		}

		try {
			const parsed = JSON.parse(body) as { status?: string };
			return parsed.status === "published" || parsed.status === "skipped";
		} catch {
			return true;
		}
	} catch (error) {
		console.error("[dev-startup-generate] failed to trigger generation", error);
		return false;
	}
}

function getWibDateKey(timestamp: number): string {
	const shifted = new Date(timestamp + WIB_OFFSET_HOURS * 60 * 60 * 1000);
	const year = shifted.getUTCFullYear();
	const month = String(shifted.getUTCMonth() + 1).padStart(2, "0");
	const day = String(shifted.getUTCDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

function normalizeTitle(input: string): string {
	return input
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/[^a-z0-9\s-]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function toSlug(input: string): string {
	const slug = input
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/[^a-z0-9\s-]/g, "")
		.trim()
		.replace(/\s+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
	return slug || "generated-post";
}

function normalizeTags(tags: string[]): string[] {
	const normalized = tags
		.map((tag) =>
			tag
				.toLowerCase()
				.trim()
				.replace(/[^a-z0-9\s-]/g, "")
				.replace(/\s+/g, "-")
				.replace(/-+/g, "-")
				.replace(/^-|-$/g, ""),
		)
		.filter(Boolean);
	return [...new Set(normalized)].slice(0, 7);
}

function canonicalizeContent(content: string): string {
	return content
		.toLowerCase()
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/`[^`]*`/g, " ")
		.replace(/\[[^\]]+\]\([^)]+\)/g, " ")
		.replace(/<[^>]+>/g, " ")
		.replace(/[#>*_~-]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function countWords(text: string): number {
	return text
		.trim()
		.split(/\s+/)
		.filter(Boolean).length;
}

async function sha256Hex(value: string): Promise<string> {
	const bytes = new TextEncoder().encode(value);
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	const hash = Array.from(new Uint8Array(digest));
	return hash.map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function buildShingles(text: string, size = 5): Set<string> {
	const tokens = text.split(" ").filter(Boolean);
	if (tokens.length <= size) {
		return new Set(tokens.length ? [tokens.join(" ")] : []);
	}
	const set = new Set<string>();
	for (let idx = 0; idx <= tokens.length - size; idx++) {
		set.add(tokens.slice(idx, idx + size).join(" "));
	}
	return set;
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
	if (!a.size && !b.size) {
		return 1;
	}
	let intersection = 0;
	for (const value of a) {
		if (b.has(value)) {
			intersection++;
		}
	}
	const union = a.size + b.size - intersection;
	return union === 0 ? 0 : intersection / union;
}

async function getRecentTitles(db: D1Database, limit: number): Promise<RecentTitleRow[]> {
	const query = await db
		.prepare(
			`SELECT title, description
			FROM ai_posts
			WHERE status = 'published'
			ORDER BY publish_at DESC
			LIMIT ?`,
		)
		.bind(limit)
		.all<RecentTitleRow>();
	return query.results ?? [];
}

async function getRecentCanonical(db: D1Database, limit: number): Promise<RecentCanonicalRow[]> {
	const query = await db
		.prepare(
			`SELECT id, title, canonical_content
			FROM ai_posts
			WHERE status = 'published'
			ORDER BY publish_at DESC
			LIMIT ?`,
		)
		.bind(limit)
		.all<RecentCanonicalRow>();
	return query.results ?? [];
}

async function slugExists(db: D1Database, slug: string): Promise<boolean> {
	const row = await db
		.prepare("SELECT slug FROM ai_posts WHERE slug = ? LIMIT 1")
		.bind(slug)
		.first<ExistingSlugRow>();
	return !!row;
}

async function ensureUniqueSlug(db: D1Database, baseSlug: string): Promise<string> {
	let slug = baseSlug;
	let suffix = 2;
	while (await slugExists(db, slug)) {
		slug = `${baseSlug}-${suffix}`;
		suffix += 1;
	}
	return slug;
}

async function hasExactTitle(db: D1Database, normalizedTitle: string): Promise<boolean> {
	const row = await db
		.prepare("SELECT id FROM ai_posts WHERE normalized_title = ? LIMIT 1")
		.bind(normalizedTitle)
		.first<ExistingTitleRow>();
	return !!row;
}

async function hasExactHash(db: D1Database, contentHash: string): Promise<boolean> {
	const row = await db
		.prepare("SELECT id FROM ai_posts WHERE content_hash = ? LIMIT 1")
		.bind(contentHash)
		.first<ExistingHashRow>();
	return !!row;
}

function buildInlineInstructions(recentRows: RecentTitleRow[]): string {
	const recent = recentRows
		.slice(0, RECENT_TITLE_WINDOW)
		.map((row, idx) => `${idx + 1}. ${row.title} :: ${row.description}`)
		.join("\n");

	return [
		"You are generating exactly one new blog article for an Astro-based blog.",
		"All written content MUST be in Bahasa Indonesia.",
		"Return only valid JSON with this exact shape:",
		'{"title": string, "description": string, "tags": string[], "mdxBody": string}',
		"Rules:",
		"- title must be <= 60 characters and unique in idea and wording.",
		"- description must be <= 180 characters.",
		"- tags must contain 2 to 5 short lowercase topic tags.",
		"- Choose one primary topic area: competitive programming, web development, cyber security, or AI/ML.",
		`- mdxBody must be between ${MIN_ARTICLE_WORDS} and ${MAX_ARTICLE_WORDS} words, target around ${TARGET_ARTICLE_WORDS} words.`,
		"- mdxBody must be valid Astro-compatible MDX body without frontmatter.",
		"- Do not include a leading or trailing code fence around the full response.",
		"- Use markdown headings, lists, tables, code fences as needed.",
		"- Ensure depth: problem framing, technical explanation, examples, pitfalls, and practical takeaways.",
		"- Admonition directives are allowed only with these types: tip, note, important, caution, warning.",
		"- Never repeat title, structure, and thesis from previous posts.",
		"- Avoid references to this instruction text.",
		"Previously published topics to avoid duplicating:",
		recent || "(none)",
	].join("\n");
}

async function continueArticleToTargetLength(
	ai: GoogleGenAI,
	env: WorkerEnv,
	systemInstructions: string,
	payload: GeneratedPayload,
): Promise<GeneratedPayload> {
	let mdxBody = payload.mdxBody.trim();
	let words = countWords(mdxBody);

	for (let attempt = 1; attempt <= MAX_CONTINUATION_ATTEMPTS && words < MIN_ARTICLE_WORDS; attempt++) {
		const remaining = MIN_ARTICLE_WORDS - words;
		const allowedExtra = MAX_ARTICLE_WORDS - words;
		if (allowedExtra <= 0) {
			break;
		}

		const minChunk = Math.max(remaining, Math.min(remaining + 80, allowedExtra));
		const maxChunk = Math.max(minChunk, Math.min(remaining + 260, allowedExtra));

		const continuationPrompt = [
			"Lanjutkan artikel berikut tanpa mengulang bagian yang sudah ada.",
			"Wajib Bahasa Indonesia.",
			`Tambahkan sekitar ${minChunk}-${maxChunk} kata agar total artikel mencapai ${MIN_ARTICLE_WORDS}-${MAX_ARTICLE_WORDS} kata.`,
			"Pertahankan kualitas teknis, alur logis, dan konsistensi gaya.",
			"Kembalikan JSON valid dengan shape tepat:",
			'{"additionalMdxBody": string}',
			"Isi artikel saat ini:",
			mdxBody,
		].join("\n\n");

		const continuationResponse = await ai.models.generateContent({
			model: env.GOOGLE_MODEL_NAME,
			contents: continuationPrompt,
			config: {
				systemInstruction: systemInstructions,
				responseMimeType: "application/json",
				temperature: 0.7,
				topP: 0.95,
			},
		});

		const rawContinuation = continuationResponse.text?.trim();
		if (!rawContinuation) {
			throw new Error("Gemini continuation response is empty");
		}

		const parsedContinuation = JSON.parse(rawContinuation) as { additionalMdxBody?: unknown };
		const additionalMdxBody =
			typeof parsedContinuation.additionalMdxBody === "string"
				? parsedContinuation.additionalMdxBody.trim()
				: "";

		if (!additionalMdxBody) {
			throw new Error("Gemini continuation response missing additionalMdxBody");
		}

		mdxBody = `${mdxBody}\n\n${additionalMdxBody}`.trim();
		words = countWords(mdxBody);
	}

	return {
		...payload,
		mdxBody,
	};
}

async function generateArticleWithGemini(
	env: WorkerEnv,
	recentRows: RecentTitleRow[],
): Promise<GeneratedPayload> {
	if (!env.GOOGLE_API_KEY?.trim()) {
		throw new Error("Missing GOOGLE_API_KEY");
	}
	if (!env.GOOGLE_MODEL_NAME?.trim()) {
		throw new Error("Missing GOOGLE_MODEL_NAME");
	}
	const systemInstructions = systemInstructionsRaw.trim();
	if (systemInstructions.length < 10) {
		throw new Error("System instructions are empty or too short");
	}

	const inlineInstructions = buildInlineInstructions(recentRows);
	const ai = new GoogleGenAI({ apiKey: env.GOOGLE_API_KEY });

	const response = await ai.models.generateContent({
		model: env.GOOGLE_MODEL_NAME,
		contents: inlineInstructions,
		config: {
			systemInstruction: systemInstructions,
			responseMimeType: "application/json",
			temperature: 0.8,
			topP: 0.95,
		},
	});

	const rawText = response.text?.trim();
	if (!rawText) {
		throw new Error("Gemini returned an empty response");
	}

	const parsed = JSON.parse(rawText) as Partial<GeneratedPayload>;
	const generatedPayload: GeneratedPayload = {
		title: `${parsed.title ?? ""}`,
		description: `${parsed.description ?? ""}`,
		tags: Array.isArray(parsed.tags) ? parsed.tags.map((tag) => `${tag}`) : [],
		mdxBody: `${parsed.mdxBody ?? ""}`,
	};

	const continuedPayload = await continueArticleToTargetLength(
		ai,
		env,
		systemInstructions,
		generatedPayload,
	);

	return {
		...continuedPayload,
		mdxBody: continuedPayload.mdxBody.trim(),
	};
}

function validateMdxBody(mdxBody: string): void {
	if (!mdxBody.trim()) {
		throw new Error("Generated mdxBody is empty");
	}
	if (/^\s*---/.test(mdxBody)) {
		throw new Error("Generated mdxBody must not include frontmatter");
	}
	const directives = [...mdxBody.matchAll(/:::(\w+)/g)]
		.map((match) => match[1]?.toLowerCase())
		.filter((value): value is string => !!value);
	const allowedDirectives = new Set(["tip", "note", "important", "caution", "warning"]);
	for (const directive of directives) {
		if (!allowedDirectives.has(directive)) {
			throw new Error(`Unsupported admonition directive: ${directive}`);
		}
	}
}

async function preparePostDraft(
	db: D1Database,
	payload: GeneratedPayload,
	modelName: string,
	now: number,
): Promise<PreparedPost> {
	const title = payload.title.trim().replace(/\s+/g, " ");
	const description = payload.description.trim().replace(/\s+/g, " ");
	const mdxBody = payload.mdxBody.trim();

	if (!title) {
		throw new Error("Generated title is empty");
	}
	if (title.length > MAX_TITLE_LENGTH) {
		throw new Error(`Generated title exceeds ${MAX_TITLE_LENGTH} characters`);
	}
	if (!description) {
		throw new Error("Generated description is empty");
	}
	if (description.length > MAX_DESCRIPTION_LENGTH) {
		throw new Error(`Generated description exceeds ${MAX_DESCRIPTION_LENGTH} characters`);
	}
	const wordCount = countWords(mdxBody);
	if (wordCount < MIN_ARTICLE_WORDS || wordCount > MAX_ARTICLE_WORDS) {
		throw new Error(
			`Generated article word count out of range (${wordCount}). Expected ${MIN_ARTICLE_WORDS}-${MAX_ARTICLE_WORDS}.`,
		);
	}

	validateMdxBody(mdxBody);

	const normalizedTitle = normalizeTitle(title);
	const canonicalContent = canonicalizeContent(mdxBody);
	const contentHash = await sha256Hex(canonicalContent);
	const baseSlug = toSlug(title);
	const slug = await ensureUniqueSlug(db, baseSlug);
	const tags = normalizeTags(payload.tags);

	if (tags.length < 2) {
		throw new Error("Generated tags are too few");
	}

	return {
		id: crypto.randomUUID(),
		slug,
		title,
		normalizedTitle,
		description,
		tags,
		mdxBody,
		wordCount,
		canonicalContent,
		contentHash,
		modelName,
		publishAt: now,
		createdAt: now,
		updatedAt: now,
	};
}

async function checkDuplicate(db: D1Database, draft: PreparedPost): Promise<DuplicateCheckResult> {
	if (await hasExactTitle(db, draft.normalizedTitle)) {
		return {
			isDuplicate: true,
			reason: "exact title duplicate",
		};
	}
	if (await hasExactHash(db, draft.contentHash)) {
		return {
			isDuplicate: true,
			reason: "exact content duplicate",
		};
	}

	const recentRows = await getRecentCanonical(db, RECENT_CONTENT_WINDOW);
	const candidateShingles = buildShingles(draft.canonicalContent);
	for (const row of recentRows) {
		const similarity = jaccardSimilarity(candidateShingles, buildShingles(row.canonical_content));
		if (similarity >= NEAR_DUPLICATE_THRESHOLD) {
			return {
				isDuplicate: true,
				reason: `near duplicate of "${row.title}"`,
				similarity,
			};
		}
	}
	return { isDuplicate: false };
}

async function persistPost(db: D1Database, draft: PreparedPost): Promise<void> {
	const stmts = [
		db
			.prepare(
				`INSERT INTO ai_posts (
					id, slug, title, normalized_title, description, tags_json,
					mdx_content, canonical_content, content_hash, model_name,
					status, publish_at, created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'published', ?, ?, ?)`,
			)
			.bind(
				draft.id,
				draft.slug,
				draft.title,
				draft.normalizedTitle,
				draft.description,
				JSON.stringify(draft.tags),
				draft.mdxBody,
				draft.canonicalContent,
				draft.contentHash,
				draft.modelName,
				draft.publishAt,
				draft.createdAt,
				draft.updatedAt,
			),
	];

	for (const tag of draft.tags) {
		stmts.push(
			db
				.prepare("INSERT INTO ai_post_tags (post_id, tag, created_at) VALUES (?, ?, ?)")
				.bind(draft.id, tag, draft.createdAt),
		);
	}

	await db.batch(stmts);
}

async function insertRunStart(
	db: D1Database,
	runId: string,
	dateKey: string,
	source: string,
	now: number,
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO ai_generation_runs (
				run_id, date_key, status, trigger_source, attempt, created_at, updated_at
			) VALUES (?, ?, 'started', ?, 0, ?, ?)`,
		)
		.bind(runId, dateKey, source, now, now)
		.run();
}

async function finalizeRun(
	db: D1Database,
	runId: string,
	status: "published" | "skipped" | "failed",
	attempt: number,
	now: number,
	options?: {
		errorMessage?: string;
		postId?: string;
		wordCount?: number;
	},
): Promise<void> {
	await db
		.prepare(
			`UPDATE ai_generation_runs
			SET status = ?, attempt = ?, error_message = ?, post_id = ?, word_count = ?, updated_at = ?
			WHERE run_id = ?`,
		)
		.bind(
			status,
			attempt,
			options?.errorMessage ?? null,
			options?.postId ?? null,
			options?.wordCount ?? null,
			now,
			runId,
		)
		.run();
}

async function triggerOrchestrator(env: Env, request: RunRequest): Promise<Response> {
	const orchestratorKey = `${request.source}:${request.scheduledTime}`;
	const id = env.BLOG_ORCHESTRATOR.idFromName(orchestratorKey);
	const stub = env.BLOG_ORCHESTRATOR.get(id);
	return stub.fetch("https://orchestrator/run", {
		method: "POST",
		headers: {
			"content-type": "application/json",
		},
		body: JSON.stringify(request),
	});
}

export class BlogGenerationOrchestrator extends DurableObject<Env> {
	override async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (request.method !== "POST" || url.pathname !== "/run") {
			return responseJson({ error: "Not found" }, 404);
		}

		let payload: RunRequest;
		try {
			payload = (await request.json()) as RunRequest;
		} catch {
			return responseJson({ error: "Invalid JSON body" }, 400);
		}

		if (!payload?.scheduledTime || !payload?.source) {
			return responseJson({ error: "scheduledTime and source are required" }, 400);
		}

		const runResult = await this.runPipeline(payload);
		const statusCode = runResult.status === "failed" ? 500 : 200;
		return responseJson(runResult, statusCode);
	}

	private async runPipeline(request: RunRequest): Promise<RunResult> {
		const dateKey = getWibDateKey(request.scheduledTime);
		const now = Date.now();
		const runId = crypto.randomUUID();

		await insertRunStart(this.env.D1, runId, dateKey, request.source, now);

		let lastError = "";
		for (let attempt = 1; attempt <= MAX_GENERATION_ATTEMPTS; attempt++) {
			try {
				const recentRows = await getRecentTitles(this.env.D1, RECENT_TITLE_WINDOW);
				const generated = await generateArticleWithGemini(this.env, recentRows);
				const draft = await preparePostDraft(
					this.env.D1,
					generated,
					this.env.GOOGLE_MODEL_NAME ?? "",
					Date.now(),
				);

				const dedupeResult = await checkDuplicate(this.env.D1, draft);
				if (dedupeResult.isDuplicate) {
					lastError = dedupeResult.reason ?? "duplicate detected";
					continue;
				}

				await persistPost(this.env.D1, draft);
				await finalizeRun(this.env.D1, runId, "published", attempt, Date.now(), {
					postId: draft.id,
					wordCount: draft.wordCount,
				});

				return {
					status: "published",
					attempt,
					postId: draft.id,
					slug: draft.slug,
					wordCount: draft.wordCount,
				};
			} catch (error) {
				lastError = error instanceof Error ? error.message : "Unknown pipeline error";
			}
		}

		await finalizeRun(this.env.D1, runId, "failed", MAX_GENERATION_ATTEMPTS, Date.now(), {
			errorMessage: lastError || "Generation failed without error message",
		});

		return {
			status: "failed",
			attempt: MAX_GENERATION_ATTEMPTS,
			reason: lastError || "Generation failed",
		};
	}
}

const worker: ExportedHandler<WorkerEnv> = {
	async fetch(request, env, ctx) {
		const url = new URL(request.url);

		if (shouldAttemptDevStartupGeneration(url, env)) {
			isAttemptingDevStartupGeneration = true;
			ctx.waitUntil(
				(async () => {
					const success = await tryDevStartupGeneration(env);
					hasAttemptedDevStartupGeneration = success;
					isAttemptingDevStartupGeneration = false;
				})(),
			);
		}

		if (url.pathname === "/api/internal/generate-now") {
			if (request.method !== "POST") {
				return responseJson({ error: "Method not allowed" }, 405);
			}
			if (env.CRON_SECRET) {
				const secret = request.headers.get("x-cron-secret");
				if (secret !== env.CRON_SECRET) {
					return responseJson({ error: "Unauthorized" }, 401);
				}
			}

			const response = await triggerOrchestrator(env, {
				scheduledTime: Date.now(),
				cron: "manual",
				source: "manual",
			});
			const text = await response.text();
			return new Response(text, {
				headers: {
					"content-type": "application/json; charset=utf-8",
				},
				status: response.status,
			});
		}

		return handle(request, env, ctx);
	},

	async scheduled(controller, env) {
		const response = await triggerOrchestrator(env, {
			scheduledTime: controller.scheduledTime,
			cron: controller.cron,
			source: "scheduled",
		});
		const body = await response.text();
		console.log(body);
	},
};

export default worker;
