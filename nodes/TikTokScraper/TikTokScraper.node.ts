// nodes/TikTokScraper/TikTokScraper.node.ts
import type {
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	IDataObject,
} from 'n8n-workflow';
import { NodeConnectionType, NodeOperationError } from 'n8n-workflow';
import { scrapeTikTokProfile } from './lib/tiktok';

export class TikTokScraper implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'TikTok Scraper',
		name: 'tikTokScraper',
		icon: 'file:icon.svg',
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["username"]}}',
		description: 'Scrape TikTok profile videos using Puppeteer.',
		defaults: { name: 'TikTok Scraper' },
		inputs: [NodeConnectionType.Main],
		outputs: [NodeConnectionType.Main],
		properties: [
			{
				displayName: 'Username',
				name: 'username',
				type: 'string',
				default: '',
				description: 'TikTok username (without @)',
				required: true,
			},
			{
				displayName: 'Max Videos',
				name: 'maxVideos',
				type: 'number',
				typeOptions: { minValue: 0 },
				default: 100,
				description: 'Maximum number of videos to scrape. Use 0 for unlimited.',
			},
			{
				displayName: 'Post Type',
				name: 'postType',
				type: 'options',
				options: [
					{ name: 'All', value: 'all' },
					{ name: 'Photo', value: 'photo' },
					{ name: 'Video', value: 'video' },
				],
				default: 'all',
				description: 'Type of posts to scrape from the profile',
			},
			{
				displayName: 'Concurrency',
				name: 'concurrency',
				type: 'number',
				typeOptions: { minValue: 1, maxValue: 10 },
				default: 4,
				description: 'Number of video tabs opened in parallel',
			},
			{
				displayName: 'Per-Video Delay (MS)',
				name: 'perVideoDelayMs',
				type: 'number',
				typeOptions: { minValue: 0 },
				default: 500,
				description: 'Delay between video scrapes in milliseconds',
			},
			{
				displayName: 'Headless',
				name: 'headless',
				type: 'options',
				noDataExpression: true,
				options: [
					{ name: 'True', value: 'true' },
					{ name: 'New', value: 'new' },
					{ name: 'False', value: 'false' },
				],
				default: 'true',
				description: 'Chromium headless mode',
			},
			{
				displayName: 'Timeout (MS)',
				name: 'timeoutMs',
				type: 'number',
				typeOptions: { minValue: 1000 },
				default: 45000,
				description: 'Navigation and selector wait timeout in milliseconds',
			},
			{
				displayName: 'Hard Scroll Timeout (MS)',
				name: 'hardScrollTimeoutMs',
				type: 'number',
				typeOptions: { minValue: 10000 },
				default: 600000,
				description: 'Maximum time to scroll the profile in milliseconds',
			},
			{
				displayName: 'User Agent',
				name: 'userAgent',
				type: 'string',
				default: '',
				description: 'Override default user agent (optional)',
			},

			// ---------------- Advanced / Optional ----------------
			{
				displayName: 'Additional Options',
				name: 'additionalOptions',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				options: [
					// 🔤 Alphabetized by displayName
					{
						displayName: 'Block Media (Faster)',
						name: 'blockMedia',
						type: 'boolean',
						default: true,
						description:
							'Whether to block images, media, fonts, and stylesheets during profile scrolling',
					},
					{
						displayName: 'Cookies (JSON Array)',
						name: 'cookiesJson',
						type: 'string',
						typeOptions: { rows: 4 },
						default: '',
						description:
							'A JSON array of cookies. Example: [{"name":"sid","value":"...","domain":".tiktok.com","path":"/","httpOnly":true,"secure":true}].',
					},
					{
						displayName: 'Emit Profile Summary',
						name: 'emitProfileSummary',
						type: 'boolean',
						default: false,
						description:
							'Whether to emit a summary item with profile counters (followers, likes, following)',
					},
					{
						displayName: 'Executable Path',
						name: 'executablePath',
						type: 'string',
						default: '',
						description: 'Custom Chrome/Chromium executable path (optional)',
					},
					{
						displayName: 'Extra Headers',
						name: 'extraHeaders',
						type: 'fixedCollection',
						typeOptions: { multipleValues: true },
						placeholder: 'Add Header',
						default: {},
						options: [
							{
								displayName: 'Headers',
								name: 'headers',
								values: [
									{ displayName: 'Name', name: 'name', type: 'string', default: '' },
									{ displayName: 'Value', name: 'value', type: 'string', default: '' },
								],
							},
						],
						description: 'Additional HTTP headers to send with requests',
					},
					{
						displayName: 'Proxy URL',
						name: 'proxyUrl',
						type: 'string',
						default: '',
						description: 'E.g., http://user:pass@host:port',
					},
					{
						displayName: 'Retries',
						name: 'retries',
						type: 'number',
						typeOptions: { minValue: 0, maxValue: 10 },
						default: 2,
						description: 'Retry attempts per video on failure',
					},
					{
						displayName: 'Viewport Height',
						name: 'viewportHeight',
						type: 'number',
						typeOptions: { minValue: 320 },
						default: 768,
						description: 'Height of the browser viewport',
					},
					{
						displayName: 'Viewport Width',
						name: 'viewportWidth',
						type: 'number',
						typeOptions: { minValue: 320 },
						default: 1366,
						description: 'Width of the browser viewport',
					},
				],
			},
		],
	};

	async execute(this: IExecuteFunctions) {
		const inputItems = this.getInputData();
		const out: INodeExecutionData[] = [];

		for (let i = 0; i < Math.max(1, inputItems.length); i++) {
			try {
				const username = this.getNodeParameter('username', i) as string;
				const maxVideos = this.getNodeParameter('maxVideos', i) as number;
				const postType = this.getNodeParameter('postType', i) as 'all' | 'video' | 'photo';
				const concurrency = this.getNodeParameter('concurrency', i) as number;
				const perVideoDelayMs = this.getNodeParameter('perVideoDelayMs', i) as number;
				const headlessOpt = this.getNodeParameter('headless', i) as 'true' | 'false' | 'new';
				const timeoutMs = this.getNodeParameter('timeoutMs', i) as number;
				const hardScrollTimeoutMs = this.getNodeParameter('hardScrollTimeoutMs', i) as number;
				const userAgent = (this.getNodeParameter('userAgent', i) as string) || undefined;

				const additional = (this.getNodeParameter('additionalOptions', i, {}) ||
					{}) as IDataObject;

				const proxyUrl = (additional.proxyUrl as string) || '';
				const executablePath = (additional.executablePath as string) || '';
				const blockMedia =
					typeof additional.blockMedia === 'boolean' ? (additional.blockMedia as boolean) : true;
				const retries = additional.retries !== undefined ? Number(additional.retries) : 2;

				const viewportWidth =
					additional.viewportWidth !== undefined ? Number(additional.viewportWidth) : 1366;
				const viewportHeight =
					additional.viewportHeight !== undefined ? Number(additional.viewportHeight) : 768;

				const emitProfileSummary =
					typeof additional.emitProfileSummary === 'boolean'
						? (additional.emitProfileSummary as boolean)
						: false;

				// Build extra headers object from fixedCollection.
				let extraHeaders: Record<string, string> | undefined;
				if (additional.extraHeaders && (additional.extraHeaders as IDataObject).headers) {
					const arr = ((additional.extraHeaders as IDataObject).headers || []) as IDataObject[];
					extraHeaders = {};
					for (const h of arr) {
						const k = (h.name as string) || '';
						if (!k) continue;
						extraHeaders[k] = String(h.value ?? '');
					}
				}

				// Parse cookies JSON array (optional).
				let cookies: Array<Record<string, any>> | undefined;
				const cookiesJson = (additional.cookiesJson as string) || '';
				if (cookiesJson.trim()) {
					try {
						const parsed = JSON.parse(cookiesJson);
						if (Array.isArray(parsed)) cookies = parsed as Array<Record<string, any>>;
						else {
							throw new NodeOperationError(
								this.getNode(),
								'“Cookies (JSON Array)” must be a JSON array.',
								{ itemIndex: i },
							);
						}
					} catch (e) {
						if (e instanceof NodeOperationError) throw e;
						throw new NodeOperationError(
							this.getNode(),
							`Invalid cookiesJson: ${(e as Error).message}`,
							{ itemIndex: i },
						);
					}
				}

				const headless: boolean | 'new' =
					headlessOpt === 'true' ? true : headlessOpt === 'false' ? false : 'new';

				// Chuẩn hóa lựa chọn post type thành mảng cho lib
				const postKinds: Array<'video' | 'photo'> =
					postType === 'all' ? (['video', 'photo'] as const).slice() : [postType];

				const results = await scrapeTikTokProfile({
					username,
					maxVideos,
					concurrency,
					perVideoDelayMs,
					headless,
					timeoutMs,
					hardScrollTimeoutMs,
					userAgent,
					proxyUrl,
					executablePath,
					blockMedia,
					retries,
					viewport: { width: viewportWidth, height: viewportHeight },
					extraHeaders,
					cookies,
					postKinds, // truyền xuống lib để lọc video/photo
					log: (m) => this.logger?.debug?.(`[TikTok] ${m}`),
				});

				// Optional: emit a single profile summary item at the beginning.
				if (emitProfileSummary) {
					const meta = (results?.[0] as any) || {};
					out.push({
						json: {
							username,
							profile_following: Number(meta.profile_following ?? 0),
							profile_followers: Number(meta.profile_followers ?? 0),
							profile_likes: Number(meta.profile_likes ?? 0),
							scraped_videos: Array.isArray(results) ? results.length : 0,
						},
					});
				}

				for (const r of results as any[]) out.push({ json: r });
			} catch (err) {
				// Only wrap non-n8n errors.
				if (err instanceof NodeOperationError) throw err;
				throw new NodeOperationError(this.getNode(), (err as Error).message, { itemIndex: i });
			}
		}

		return [out];
	}
}
