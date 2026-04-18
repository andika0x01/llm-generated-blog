import rss from "@astrojs/rss";
import { getD1Binding, listPublishedPosts } from "@/data/ai-post";
import { siteConfig } from "@/site.config";

export const GET = async () => {
	const db = getD1Binding();
	const posts = db ? await listPublishedPosts(db, { limit: 1000 }) : [];

	return rss({
		title: siteConfig.title,
		description: siteConfig.description,
		site: import.meta.env.SITE,
		items: posts.map((post) => ({
			title: post.title,
			description: post.description,
			pubDate: new Date(post.publishAt),
			link: `posts/${post.slug}/`,
		})),
	});
};
