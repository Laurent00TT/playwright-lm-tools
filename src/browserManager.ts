import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { chromium } from 'playwright-core';
import type {
	Browser,
	BrowserContext,
	Dialog,
	Locator,
	Page,
	Request,
	Response,
} from 'playwright-core';
import * as vscode from 'vscode';

type Channel = 'msedge' | 'chrome';

export interface ConsoleEntry {
	time: string;
	level: string;
	text: string;
}

export interface NetworkEntry {
	id: number;
	method: string;
	url: string;
	resourceType: string;
	status?: number;
	failure?: string;
	request: Request;
	response?: Response;
}

export interface DialogInfo {
	type: string;
	message: string;
	defaultValue: string;
}

const CONSOLE_CAP = 300;
const NETWORK_CAP = 150;

/**
 * 扩展内单例的浏览器管理器:惰性启动、channel 回退、快照与 ref 定位、
 * 弹窗挂起管理、console/network 环形缓冲、storageState 存取。
 * 所有工具共享同一个 Browser/Context/Page。
 */
export class BrowserManager {
	private browser?: Browser;
	private context?: BrowserContext;
	private page?: Page;
	private launching?: Promise<Page>;

	private consoleBuf: ConsoleEntry[] = [];
	private networkBuf: NetworkEntry[] = [];
	private nextRequestId = 1;
	// FIFO:连环弹窗(如 alert 套 confirm)逐个交给模型处理,不许覆盖丢失
	private dialogs: Dialog[] = [];
	private dialogWaiters: Array<() => void> = [];

	get actionTimeout(): number {
		return vscode.workspace
			.getConfiguration('pwTools')
			.get<number>('actionTimeoutMs', 10_000);
	}

	get navigationTimeout(): number {
		return vscode.workspace
			.getConfiguration('pwTools')
			.get<number>('navigationTimeoutMs', 30_000);
	}

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

	// ---------- 弹窗 ----------

	/** 当前挂起的 JS 弹窗(队首);挂起期间对应页面 JS 被阻塞。 */
	get pendingDialog(): DialogInfo | undefined {
		const dialog = this.dialogs[0];
		if (!dialog) {
			return undefined;
		}
		return {
			type: dialog.type(),
			message: dialog.message(),
			defaultValue: dialog.defaultValue(),
		};
	}

	/** 一次性等待器:弹窗出现时 resolve;调用方用完必须 dispose 防止泄漏。 */
	waitForDialog(): { promise: Promise<void>; dispose: () => void } {
		if (this.dialogs.length) {
			// 已有挂起弹窗:立即命中,act() 的竞速不必空等动作超时
			return { promise: Promise.resolve(), dispose: () => {} };
		}
		let resolver!: () => void;
		const promise = new Promise<void>((resolve) => {
			resolver = resolve;
		});
		this.dialogWaiters.push(resolver);
		return {
			promise,
			dispose: () => {
				const i = this.dialogWaiters.indexOf(resolver);
				if (i >= 0) {
					this.dialogWaiters.splice(i, 1);
				}
			},
		};
	}

	async handleDialog(
		accept: boolean,
		promptText?: string
	): Promise<DialogInfo & { next?: string }> {
		// 所属页面已被手动关掉的死条目直接丢弃,不许堵住队列
		while (this.dialogs.length) {
			const page = this.dialogs[0].page();
			if (page && page.isClosed()) {
				this.dialogs.shift();
				continue;
			}
			break;
		}
		const dialog = this.dialogs.shift();
		if (!dialog) {
			throw new Error('No dialog is currently open.');
		}
		const info: DialogInfo = {
			type: dialog.type(),
			message: dialog.message(),
			defaultValue: dialog.defaultValue(),
		};
		try {
			if (accept) {
				await dialog.accept(promptText);
			} else {
				await dialog.dismiss();
			}
		} catch {
			// 弹窗可能已随页面消失;不能因此卡死队列
		}
		const next = this.dialogs[0];
		return next ? { ...info, next: `${next.type()}: "${next.message()}"` } : info;
	}

	// ---------- console / network 缓冲 ----------

	consoleEntries(onlyErrors: boolean): ConsoleEntry[] {
		return onlyErrors
			? this.consoleBuf.filter((e) => e.level === 'error')
			: [...this.consoleBuf];
	}

	clearConsole(): void {
		this.consoleBuf = [];
	}

	networkEntries(urlFilter?: string): NetworkEntry[] {
		if (!urlFilter) {
			return [...this.networkBuf];
		}
		const needle = urlFilter.toLowerCase();
		return this.networkBuf.filter((e) => e.url.toLowerCase().includes(needle));
	}

	networkEntry(id: number): NetworkEntry | undefined {
		return this.networkBuf.find((e) => e.id === id);
	}

	// ---------- storageState 存取 ----------

	stateFilePath(name: string): string {
		const safe = name.replace(/[^a-zA-Z0-9_-]/g, '_') || 'default';
		return path.join(this.stateDir(), `${safe}.json`);
	}

	async saveState(name: string): Promise<string> {
		this.requirePage();
		const file = this.stateFilePath(name);
		await fs.mkdir(path.dirname(file), { recursive: true });
		await this.context!.storageState({ path: file });
		return file;
	}

	/** 恢复 storageState:storageState 只能在建 context 时注入,因此重建 context。 */
	async loadState(name: string): Promise<string> {
		const file = this.stateFilePath(name);
		await fs.access(file).catch(() => {
			throw new Error(
				`No saved state named "${name}" (looked at ${file}). Use pw_save_state first.`
			);
		});
		await this.getPage();
		const browser = this.browser!;
		const old = this.context;
		// 旧 context 即将销毁:先摘掉全部监听,防止 swap 的 await 间隙里
		// 它的 dialog/page/console 事件污染 manager 状态(僵尸弹窗会锁死门禁)
		old?.removeAllListeners();
		this.dialogs = [];
		const context = await browser.newContext({ storageState: file });
		this.attachContext(context);
		this.context = context;
		this.page = await context.newPage();
		await old?.close().catch(() => {});
		return file;
	}

	// ---------- 快照 / 截图 ----------

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

	// ---------- 内部 ----------

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
		const context = await this.browser.newContext();
		this.attachContext(context);
		this.context = context;
		this.page = await context.newPage();
		return this.page;
	}

	/** context 级事件一次挂全:新标签跟随、console/网络缓冲、弹窗挂起。 */
	private attachContext(context: BrowserContext): void {
		// 页面里 target=_blank 打开的新标签自动成为当前操作页
		context.on('page', (p) => {
			this.page = p;
		});
		context.on('console', (msg) => {
			this.pushConsole(msg.type(), msg.text());
		});
		context.on('weberror', (webError) => {
			this.pushConsole('error', `[uncaught] ${webError.error().message}`);
		});
		context.on('dialog', (dialog) => {
			if (dialog.type() === 'beforeunload') {
				// beforeunload 极少是测试目标,自动接受以免阻塞导航
				void dialog.accept().catch(() => {});
				this.pushConsole('info', '[beforeunload dialog auto-accepted]');
				return;
			}
			// 不立即响应:挂起弹窗,由 pw_handle_dialog 决定 accept/dismiss
			this.dialogs.push(dialog);
			this.dialogWaiters.splice(0).forEach((fn) => fn());
		});
		context.on('request', (request) => {
			this.networkBuf.push({
				id: this.nextRequestId++,
				method: request.method(),
				url: request.url(),
				resourceType: request.resourceType(),
				request,
			});
			if (this.networkBuf.length > NETWORK_CAP) {
				this.networkBuf.splice(0, this.networkBuf.length - NETWORK_CAP);
			}
		});
		context.on('response', (response) => {
			const entry = this.networkBuf.find((e) => e.request === response.request());
			if (entry) {
				entry.status = response.status();
				entry.response = response;
			}
		});
		context.on('requestfailed', (request) => {
			const entry = this.networkBuf.find((e) => e.request === request);
			if (entry) {
				entry.failure = request.failure()?.errorText ?? 'failed';
			}
		});
	}

	private pushConsole(level: string, text: string): void {
		this.consoleBuf.push({
			time: new Date().toTimeString().slice(0, 8),
			level,
			text: text.length > 500 ? text.slice(0, 500) + '…' : text,
		});
		if (this.consoleBuf.length > CONSOLE_CAP) {
			this.consoleBuf.splice(0, this.consoleBuf.length - CONSOLE_CAP);
		}
	}

	private stateDir(): string {
		const configured = vscode.workspace
			.getConfiguration('pwTools')
			.get<string>('stateDir', '');
		if (configured) {
			return configured;
		}
		const ws = vscode.workspace.workspaceFolders?.[0];
		if (ws) {
			return path.join(ws.uri.fsPath, '.pw-state');
		}
		return path.join(os.tmpdir(), 'playwright-lm-tools', 'state');
	}

	private resetState(): void {
		this.browser = undefined;
		this.context = undefined;
		this.page = undefined;
		this.dialogs = [];
		this.consoleBuf = [];
		this.networkBuf = [];
	}
}
