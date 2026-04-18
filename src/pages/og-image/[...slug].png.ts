import type { APIContext } from "astro";
import sharp from "sharp";
import satori, { type SatoriOptions } from "satori";
import RobotoMonoBold from "@/assets/roboto-mono-700.ttf";
import RobotoMono from "@/assets/roboto-mono-regular.ttf";
import { getAllPosts } from "@/data/post";
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

export const prerender = false;

export async function GET(context: APIContext) {
	const slug = context.params.slug;
	if (!slug) {
		return new Response("Not found", { status: 404 });
	}

	const posts = await getAllPosts();
	const post = posts.find((entry) => entry.id === slug);
	if (!post) {
		return new Response("Not found", { status: 404 });
	}

	const pubDate = post.data.updatedDate ?? post.data.publishDate;
	const title = post.data.title;

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
