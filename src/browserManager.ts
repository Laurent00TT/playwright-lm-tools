import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { chromium } from 'playwright-core';
import type { Browser, BrowserContext, Locator, Page } from 'playwright-core';
import * as vscode from 'vscode';

type Channel = 'msedge' | 'chrome';

/**
 * 扩展内单例的浏览器管理器:惰性启动、channel 回退、快照与 ref 定位。
 * 所有工具共享同一个 Browser/Context/Page。
 */
export class BrowserManager {
	private browser?: Browser;
	private context?: BrowserContext;
	private page?: Page;
	private launching?: Promise<Page>;

	/** 获取当前页面;浏览器未启动时先启动(并发调用共享同一次启动)。 */
	async getPage(): Promise<Page> {
		const alive = this.alivePage();
		if (alive) {
			return alive;
		}
		if (!this.launching) {
			this.launching = this.launch().finally(() => {
				this.launching = undefined;
			});
		}
		return this.launching;
	}

	/** 仅当浏览器已启动时返回页面,否则抛错 —— click/type/snapshot 等前置校验。 */
	requirePage(): Page {
		const page = this.alivePage();
		if (!page) {
			throw new Error('No browser page is open yet. Call pw_navigate first.');
		}
		return page;
	}

	get isRunning(): boolean {
		return this.browser?.isConnected() ?? false;
	}

	/** 由快照中的 ref(如 e12)得到 Playwright 定位器。 */
	refLocator(ref: string): Locator {
		return this.requirePage().locator(`aria-ref=${ref}`);
	}

	/** 返回带 [ref=eN] 标注的无障碍树文本快照,超长按配置截断。 */
	async snapshot(page?: Page): Promise<string> {
		// 调用方已解析好页面时直接复用,避免 URL/标题与快照来自不同页面
		let text = await this.captureAriaTree(page ?? this.requirePage());
		const max = vscode.workspace
			.getConfiguration('pwTools')
			.get<number>('snapshotMaxChars', 24000);
		if (max > 0 && text.length > max) {
			text =
				text.slice(0, max) +
				`\n... [snapshot truncated at ${max} chars — interact with the page to narrow it, or raise pwTools.snapshotMaxChars]`;
		}
		return text;
	}

	/**
	 * 三级探测抓取 AI 快照,兼容不同 playwright-core 版本:
	 * 1.62+ 公开 API page.ariaSnapshot({mode:'ai'})(_snapshotForAI 的转正形态)
	 * → 旧内部 _snapshotForAI() → 更旧的 locator.ariaSnapshot({ref:true})。
	 * 注意 1.62 里 {ref:true} 会被协议层静默丢弃、产出无 ref 的快照,必须走公开 API。
	 */
	private async captureAriaTree(page: Page): Promise<string> {
		const modern = page as Page & {
			ariaSnapshot?: (options: { mode: 'ai' }) => Promise<string>;
		};
		if (typeof modern.ariaSnapshot === 'function') {
			return modern.ariaSnapshot({ mode: 'ai' });
		}
		const legacy = page as Page & { _snapshotForAI?: () => Promise<string> };
		if (typeof legacy._snapshotForAI === 'function') {
			return legacy._snapshotForAI();
		}
		return (page.locator('body') as unknown as {
			ariaSnapshot(options: { ref: boolean }): Promise<string>;
		}).ariaSnapshot({ ref: true });
	}

	/** 截图存到系统临时目录,返回文件路径与 PNG 数据。 */
	async screenshot(fullPage: boolean): Promise<{ file: string; data: Buffer }> {
		const page = this.requirePage();
		const data = await page.screenshot({ fullPage, type: 'png' });
		const dir = path.join(os.tmpdir(), 'playwright-lm-tools');
		await fs.mkdir(dir, { recursive: true });
		const stamp = new Date().toISOString().replace(/[:.]/g, '-');
		const file = path.join(dir, `screenshot-${stamp}.png`);
		await fs.writeFile(file, data);
		return { file, data };
	}

	async close(): Promise<void> {
		const browser = this.browser;
		this.resetState();
		await browser?.close().catch(() => {});
	}

	/** 当前页可能被用户手动关掉,退回 context 中最后一个仍打开的页面。 */
	private alivePage(): Page | undefined {
		if (this.page && !this.page.isClosed()) {
			return this.page;
		}
		const pages = this.context?.pages().filter((p) => !p.isClosed()) ?? [];
		this.page = pages.at(-1);
		return this.page;
	}

	private async launch(): Promise<Page> {
		const cfg = vscode.workspace.getConfiguration('pwTools');
		const preferred = cfg.get<Channel>('channel', 'msedge');
		const headless = cfg.get<boolean>('headless', false);
		const channels: Channel[] =
			preferred === 'chrome' ? ['chrome', 'msedge'] : ['msedge', 'chrome'];

		const errors: string[] = [];
		for (const channel of channels) {
			try {
				this.browser = await chromium.launch({ channel, headless });
				break;
			} catch (err) {
				const first =
					err instanceof Error ? err.message.split('\n')[0] : String(err);
				errors.push(`${channel}: ${first}`);
			}
		}
		if (!this.browser) {
			throw new Error(
				`Failed to launch a local browser. Tried channels [${channels.join(', ')}]. ` +
					`Make sure Microsoft Edge or Google Chrome is installed. Details: ${errors.join(' | ')}`
			);
		}

		this.browser.once('disconnected', () => this.resetState());
		this.context = await this.browser.newContext();
		// 页面里 target=_blank 打开的新标签自动成为当前操作页
		this.context.on('page', (p) => {
			this.page = p;
		});
		this.page = await this.context.newPage();
		return this.page;
	}

	private resetState(): void {
		this.browser = undefined;
		this.context = undefined;
		this.page = undefined;
	}
}
