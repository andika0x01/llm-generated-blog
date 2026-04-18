import type { APIContext } from "astro";
import sharp from "sharp";
import satori, { type SatoriOptions } from "satori";
import RobotoMonoBold from "@/assets/roboto-mono-700.ttf";
import RobotoMono from "@/assets/roboto-mono-regular.ttf";
import { getD1Binding, getPublishedPostBySlug } from "@/data/ai-post";
import { getFormattedDate } from "@/utils/date";
import { ogMarkup } from "./_ogMarkup";

const ogOptions: SatoriOptions = {
	// debug: true,
	fonts: [
		{
			data: Buffer.from(RobotoMono),
			name: "Roboto Mono",
			style: "normal",
			weight: 400,
		},
		{
			data: Buffer.from(RobotoMonoBold),
			name: "Roboto Mono",
			style: "normal",
			weight: 700,
		},
	],
	height: 630,
	width: 1200,
};

export async function GET(context: APIContext) {
	const slug = context.params.slug;
	if (!slug) {
		return new Response("Not found", { status: 404 });
	}

	const db = getD1Binding();
	if (!db) {
		return new Response("D1 binding unavailable", { status: 500 });
	}

	const post = await getPublishedPostBySlug(db, slug);
	if (!post) {
		return new Response("Not found", { status: 404 });
	}

	const pubDate = new Date(post.updatedAt || post.publishAt);
	const title = post.title;

	const postDate = getFormattedDate(pubDate, {
		month: "long",
		weekday: "long",
	});
	const svg = await satori(ogMarkup(title, postDate), ogOptions);
	const pngBuffer = await sharp(Buffer.from(svg)).png().toBuffer();
	const png = new Uint8Array(pngBuffer);
	return new Response(png, {
		headers: {
			"Cache-Control": "public, max-age=31536000, immutable",
			"Content-Type": "image/png",
		},
	});
}
