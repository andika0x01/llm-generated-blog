declare module "@pagefind/default-ui" {
	declare class PagefindUI {
		constructor(arg: unknown);
	}
}

declare module "*.md?raw" {
	const content: string;
	export default content;
}
