import { env } from "cloudflare:workers";

interface AIPostRow {
	id: string;
	slug: string;
	title: string;
	description: string;
	tags_json: string;
	mdx_content: string;
	publish_at: number;
	created_at: number;
	updated_at: number;
}

export interface AIPost {
	id: string;
	slug: string;
	title: string;
	description: string;
	tags: string[];
	mdxContent: string;
	publishAt: number;
	createdAt: number;
	updatedAt: number;
}

interface AITagRow {
	tag: string;
	count: number;
}

export interface AITagSummary {
	tag: string;
	count: number;
}

function parseTags(tagsJson: string): string[] {
	try {
		const parsed = JSON.parse(tagsJson);
		return Array.isArray(parsed) ? parsed.filter((value) => typeof value === "string") : [];
	} catch {
		return [];
	}
}

function mapRow(row: AIPostRow): AIPost {
	return {
		id: row.id,
		slug: row.slug,
		title: row.title,
		description: row.description,
		tags: parseTags(row.tags_json),
		mdxContent: row.mdx_content,
		publishAt: row.publish_at,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

export function getD1Binding(): D1Database | null {
	try {
		return env.D1 ?? null;
	} catch {
		return null;
	}
}

export async function listPublishedPosts(
	db: D1Database,
	options?: {
		limit?: number;
		offset?: number;
	},
): Promise<AIPost[]> {
	const limit = options?.limit ?? 500;
	const offset = options?.offset ?? 0;

	const query = await db
		.prepare(
			`SELECT id, slug, title, description, tags_json, mdx_content, publish_at, created_at, updated_at
			FROM ai_posts
			WHERE status = 'published'
			ORDER BY publish_at DESC
			LIMIT ?
			OFFSET ?`,
		)
		.bind(limit, offset)
		.all<AIPostRow>();

	return (query.results ?? []).map(mapRow);
}

export async function getPublishedPostBySlug(db: D1Database, slug: string): Promise<AIPost | null> {
	const row = await db
		.prepare(
			`SELECT id, slug, title, description, tags_json, mdx_content, publish_at, created_at, updated_at
			FROM ai_posts
			WHERE status = 'published' AND slug = ?
			LIMIT 1`,
		)
		.bind(slug)
		.first<AIPostRow>();

	return row ? mapRow(row) : null;
}

export async function listPublishedTags(
	db: D1Database,
	options?: {
		limit?: number;
	},
): Promise<AITagSummary[]> {
	const limit = options?.limit ?? 100;
	const query = await db
		.prepare(
			`SELECT j.value as tag, COUNT(*) as count
			FROM ai_posts p, json_each(CASE WHEN json_valid(p.tags_json) THEN p.tags_json ELSE '[]' END) j
			WHERE p.status = 'published'
			  AND j.type = 'text'
			GROUP BY j.value
			ORDER BY count DESC, j.value ASC
			LIMIT ?`,
		)
		.bind(limit)
		.all<AITagRow>();

	return (query.results ?? []).map((row) => ({
		tag: row.tag,
		count: Number(row.count),
	}));
}

export async function listPublishedPostsByTag(
	db: D1Database,
	tag: string,
	options?: {
		limit?: number;
		offset?: number;
	},
): Promise<AIPost[]> {
	const limit = options?.limit ?? 100;
	const offset = options?.offset ?? 0;

	const query = await db
		.prepare(
			`SELECT p.id, p.slug, p.title, p.description, p.tags_json, p.mdx_content, p.publish_at, p.created_at, p.updated_at
			FROM ai_posts p
			WHERE p.status = 'published'
			  AND EXISTS (
				SELECT 1
				FROM json_each(CASE WHEN json_valid(p.tags_json) THEN p.tags_json ELSE '[]' END) j
				WHERE j.type = 'text'
				  AND j.value = ?
			  )
			ORDER BY p.publish_at DESC
			LIMIT ?
			OFFSET ?`,
		)
		.bind(tag, limit, offset)
		.all<AIPostRow>();

	return (query.results ?? []).map(mapRow);
}
