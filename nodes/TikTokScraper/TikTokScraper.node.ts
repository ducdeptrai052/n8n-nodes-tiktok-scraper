// nodes/TikTokScraper/TikTokScraper.node.ts
import type {
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionType, NodeOperationError } from 'n8n-workflow';
import { scrapeTikTokProfile } from './lib/tiktok';

export class TikTokScraper implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'TikTok Scraper',
		name: 'tikTokScraper', // giữ camelCase, chữ đầu thường theo chuẩn n8n
		icon: 'file:icon.svg',
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["username"]}}',
		description: 'Scrape TikTok profile videos using Puppeteer',
		defaults: { name: 'TikTok Scraper' },
		inputs: [NodeConnectionType.Main],
		outputs: [NodeConnectionType.Main],
		properties: [
			{
				displayName: 'Username',
				name: 'username',
				type: 'string',
				default: 'zebracat.ai',
				description: 'TikTok username (without @)',
				required: true,
			},
			{
				displayName: 'Max Videos',
				name: 'maxVideos',
				type: 'number',
				typeOptions: { minValue: 0 },
				default: 0,
				description: 'Maximum number of videos to scrape. Use 0 for unlimited',
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
				displayName: 'Per-Video Delay',
				name: 'perVideoDelayMs',
				type: 'number',
				typeOptions: { minValue: 0 },
				default: 500,
				description: 'Delay between video scrapes (milliseconds)',
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
				displayName: 'Timeout',
				name: 'timeoutMs',
				type: 'number',
				typeOptions: { minValue: 1000 },
				default: 45000,
				description: 'Navigation and selector wait timeout (milliseconds)',
			},
			{
				displayName: 'Hard Scroll Timeout',
				name: 'hardScrollTimeoutMs',
				type: 'number',
				typeOptions: { minValue: 10000 },
				default: 600000,
				description: 'Maximum time to scroll the profile (milliseconds)',
			},
			{
				displayName: 'User Agent',
				name: 'userAgent',
				type: 'string',
				default: '',
				description: 'Override default user agent (optional)',
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
				const concurrency = this.getNodeParameter('concurrency', i) as number;
				const perVideoDelayMs = this.getNodeParameter('perVideoDelayMs', i) as number;
				const headlessOpt = this.getNodeParameter('headless', i) as 'true' | 'false' | 'new';
				const timeoutMs = this.getNodeParameter('timeoutMs', i) as number;
				const hardScrollTimeoutMs = this.getNodeParameter('hardScrollTimeoutMs', i) as number;
				const userAgent = (this.getNodeParameter('userAgent', i) as string) || undefined;

				const headless: boolean | 'new' =
					headlessOpt === 'true' ? true : headlessOpt === 'false' ? false : 'new';

				const results = await scrapeTikTokProfile({
					username,
					maxVideos,
					concurrency,
					perVideoDelayMs,
					headless,
					timeoutMs,
					hardScrollTimeoutMs,
					userAgent,
				});

				for (const r of results as any[]) out.push({ json: r });
			} catch (err) {
				throw new NodeOperationError(this.getNode(), err as Error, { itemIndex: i });
			}
		}

		return [out];
	}
}
