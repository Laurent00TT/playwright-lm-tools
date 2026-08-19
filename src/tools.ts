import type { Page } from 'playwright-core';
import * as vscode from 'vscode';
import type { BrowserManager } from './browserManager';

function textResult(text: string): vscode.LanguageModelToolResult {
	return new vscode.LanguageModelToolResult([
		new vscode.LanguageModelTextPart(text),
	]);
}

function firstLine(err: unknown): string {
	return (err instanceof Error ? err.message : String(err)).split('\n')[0];
}

/** 错误统一转成给模型看的文本;ref 失效/超时时附带下一步建议。 */
function describeError(err: unknown): string {
	const message = err instanceof Error ? err.message : String(err);
	let hint = '';
	if (/aria-ref|resolve.*ref|stale/i.test(message)) {
		hint =
			' The ref is probably stale — call pw_snapshot to get fresh refs, then retry.';
	} else if (/timeout/i.test(message)) {
		hint =
			' The element may not exist or the page may still be loading — call pw_snapshot to inspect the current page state.';
	}
	return `Error: ${message}${hint}`;
}

function throwIfCancelled(token: vscode.CancellationToken): void {
	if (token.isCancellationRequested) {
		throw new vscode.CancellationError();
	}
}

/**
 * 让长耗时的 playwright 调用可被用户 Stop 打断。playwright 没有逐操作中止,
 * race 只保证工具及时返回;残留的浏览器动作由调用方在步骤间检查 token 来收敛。
 */
async function raceCancellation<T>(
	promise: Promise<T>,
	token: vscode.CancellationToken
): Promise<T> {
	throwIfCancelled(token);
	let sub: vscode.Disposable | undefined;
	const cancelled = new Promise<never>((_, reject) => {
		sub = token.onCancellationRequested(() =>
			reject(new vscode.CancellationError())
		);
	});
	try {
		return await Promise.race([promise, cancelled]);
	} finally {
		sub?.dispose();
		// 被放弃的 playwright promise 之后可能 reject,吞掉以免 unhandled rejection
		promise.catch(() => {});
	}
}

/**
 * 动作后的稳定窗口:先让出事件循环,给 context 'page' 事件(target=_blank /
 * window.open 新标签)一个派发机会,再对"此刻的当前页"等待加载。绝不抛错。
 */
async function settle(manager: BrowserManager): Promise<void> {
	await new Promise<void>((resolve) => setTimeout(resolve, 100));
	try {
		const page = manager.requirePage();
		await page.waitForLoadState('load', { timeout: 5_000 });
	} catch {
		// 页面可能已关闭或仍在导航;由 actionResult 兜底
	}
}

/**
 * 所有 pw_* 工具的公共骨架:取消语义、异常兜底转文本、
 * 统一的"操作结果 + 新快照"回复格式。
 */
abstract class PwTool<T> implements vscode.LanguageModelTool<T> {
	constructor(
		protected readonly manager: BrowserManager,
		protected readonly log: vscode.OutputChannel
	) {}

	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<T>,
		token: vscode.CancellationToken
	): Promise<vscode.LanguageModelToolResult> {
		this.log.appendLine(
			`[${this.constructor.name}] input: ${JSON.stringify(options.input)}`
		);
		throwIfCancelled(token);
		try {
			return await this.run(options.input, token);
		} catch (err) {
			// 用户按 Stop:按取消语义上抛,VS Code 丢弃结果,不算工具报错
			if (err instanceof vscode.CancellationError || token.isCancellationRequested) {
				throw new vscode.CancellationError();
			}
			const text = describeError(err);
			this.log.appendLine(`[${this.constructor.name}] ${text}`);
			return textResult(text);
		}
	}

	protected abstract run(
		input: T,
		token: vscode.CancellationToken
	): Promise<vscode.LanguageModelToolResult>;

	/** 操作结果统一格式:动作描述 + 当前 URL/标题 + 新快照,让模型无需追加调用。 */
	protected async pageState(header: string): Promise<string> {
		const page = this.manager.requirePage();
		const title = await page.title().catch(() => '');
		let snapshot: string;
		try {
			snapshot = await this.manager.snapshot(page);
		} catch (err) {
			// 快照失败(页面导航中等)降级为占位文本,不能吞掉已有信息
			snapshot = `[snapshot unavailable: ${firstLine(err)} — call pw_snapshot to inspect the current page]`;
		}
		return [
			header,
			'',
			`Page URL: ${page.url()}`,
			`Page title: ${title}`,
			'',
			'Page snapshot:',
			snapshot,
		].join('\n');
	}

	/** 动作已落地后调用:抓取页面状态再失败,也绝不把成功的动作说成失败。 */
	protected async actionResult(
		header: string
	): Promise<vscode.LanguageModelToolResult> {
		try {
			return textResult(await this.pageState(header));
		} catch (err) {
			return textResult(
				`${header}\n\nThe action itself completed, but the post-action page state could not be captured (${firstLine(err)}). Call pw_snapshot to inspect the current page.`
			);
		}
	}
}

interface NavigateInput {
	url: string;
}

class NavigateTool extends PwTool<NavigateInput> {
	protected async run(
		{ url }: NavigateInput,
		token: vscode.CancellationToken
	): Promise<vscode.LanguageModelToolResult> {
		if (!url) {
			throw new Error('Parameter "url" is required.');
		}
		const hasScheme = /^(https?|file|about|data|chrome|edge):/i.test(url);
		const target = hasScheme ? url : `https://${url}`;
		const page = await this.manager.getPage();
		await raceCancellation(
			page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30_000 }),
			token
		);
		return this.actionResult(`Navigated to ${target}`);
	}

	prepareInvocation(
		options: vscode.LanguageModelToolInvocationPrepareOptions<NavigateInput>
	): vscode.ProviderResult<vscode.PreparedToolInvocation> {
		return { invocationMessage: `打开 ${options.input.url}` };
	}
}

class SnapshotTool extends PwTool<Record<string, never>> {
	protected async run(): Promise<vscode.LanguageModelToolResult> {
		return textResult(await this.pageState('Captured page snapshot'));
	}

	prepareInvocation(): vscode.ProviderResult<vscode.PreparedToolInvocation> {
		return { invocationMessage: '抓取页面快照' };
	}
}

interface ClickInput {
	ref: string;
	element: string;
}

class ClickTool extends PwTool<ClickInput> {
	protected async run(
		{ ref, element }: ClickInput,
		token: vscode.CancellationToken
	): Promise<vscode.LanguageModelToolResult> {
		const page = this.manager.requirePage();
		const locator = this.manager.refLocator(ref);
		// target=_blank 会开新标签,popup 事件要在点击前挂好等待器才追得上
		const opensTab = await locator
			.evaluate((el) => {
				const anchor = el.closest('a');
				return !!anchor && anchor.target === '_blank';
			})
			.catch(() => false);
		const popupPromise: Promise<Page | undefined> = opensTab
			? page.waitForEvent('popup', { timeout: 10_000 }).catch(() => undefined)
			: Promise.resolve(undefined);
		await raceCancellation(locator.click({ timeout: 10_000 }), token);
		const popup = await popupPromise;
		if (popup) {
			await popup
				.waitForLoadState('domcontentloaded', { timeout: 5_000 })
				.catch(() => {});
		}
		await settle(this.manager);
		return this.actionResult(`Clicked "${element}" (ref=${ref})`);
	}

	prepareInvocation(
		options: vscode.LanguageModelToolInvocationPrepareOptions<ClickInput>
	): vscode.ProviderResult<vscode.PreparedToolInvocation> {
		return { invocationMessage: `点击 ${options.input.element}` };
	}
}

interface TypeInput {
	ref: string;
	element: string;
	text: string;
	submit?: boolean;
	slowly?: boolean;
}

class TypeTool extends PwTool<TypeInput> {
	protected async run(
		input: TypeInput,
		token: vscode.CancellationToken
	): Promise<vscode.LanguageModelToolResult> {
		this.manager.requirePage();
		const locator = this.manager.refLocator(input.ref);
		if (input.slowly) {
			await raceCancellation(locator.click({ timeout: 10_000 }), token);
			// 分块逐字输入并在块间检查取消,Stop 后残留输入至多一个块
			for (const chunk of input.text.match(/.{1,8}/gs) ?? []) {
				throwIfCancelled(token);
				await locator.pressSequentially(chunk, { delay: 50 });
			}
		} else {
			await raceCancellation(locator.fill(input.text, { timeout: 10_000 }), token);
		}
		if (input.submit) {
			throwIfCancelled(token);
			await locator.press('Enter');
		}
		await settle(this.manager);
		const suffix = input.submit ? ' and pressed Enter' : '';
		return this.actionResult(
			`Typed "${input.text}" into "${input.element}"${suffix}`
		);
	}

	prepareInvocation(
		options: vscode.LanguageModelToolInvocationPrepareOptions<TypeInput>
	): vscode.ProviderResult<vscode.PreparedToolInvocation> {
		return { invocationMessage: `向 ${options.input.element} 输入文本` };
	}
}

interface ScreenshotInput {
	fullPage?: boolean;
}

class ScreenshotTool extends PwTool<ScreenshotInput> {
	protected async run(input: ScreenshotInput): Promise<vscode.LanguageModelToolResult> {
		const { file, data } = await this.manager.screenshot(!!input.fullPage);
		const parts: unknown[] = [
			new vscode.LanguageModelTextPart(`Screenshot saved to ${file}`),
		];
		// LanguageModelDataPart(工具结果内联图片)在较新的 VS Code 才有,旧版本降级为仅返回路径
		const DataPart = (
			vscode as unknown as {
				LanguageModelDataPart?: {
					image(data: Uint8Array, mimeType: string): unknown;
				};
			}
		).LanguageModelDataPart;
		if (DataPart && typeof DataPart.image === 'function') {
			parts.push(DataPart.image(data, 'image/png'));
		}
		return new vscode.LanguageModelToolResult(
			parts as vscode.LanguageModelTextPart[]
		);
	}

	prepareInvocation(): vscode.ProviderResult<vscode.PreparedToolInvocation> {
		return { invocationMessage: '截取页面截图' };
	}
}

interface WaitInput {
	seconds?: number;
	text?: string;
}

class WaitTool extends PwTool<WaitInput> {
	protected async run(
		input: WaitInput,
		token: vscode.CancellationToken
	): Promise<vscode.LanguageModelToolResult> {
		if (input.seconds === undefined && !input.text) {
			throw new Error('Provide "seconds", "text", or both.');
		}
		const page = this.manager.requirePage();
		const capped = Math.min(Math.max(input.seconds ?? 0, 0), 30);
		if (input.text) {
			// filter({visible:true}) 避免 first() 钉死在 DOM 更靠前的隐藏匹配上
			await raceCancellation(
				page
					.getByText(input.text)
					.filter({ visible: true })
					.first()
					.waitFor({ state: 'visible', timeout: (capped || 15) * 1000 }),
				token
			);
			return this.actionResult(`Text "${input.text}" is now visible`);
		}
		// 纯计时不需要页面参与,可取消的 setTimeout 即可
		await raceCancellation(
			new Promise<void>((resolve) => setTimeout(resolve, capped * 1000)),
			token
		);
		return this.actionResult(`Waited ${capped}s`);
	}

	prepareInvocation(
		options: vscode.LanguageModelToolInvocationPrepareOptions<WaitInput>
	): vscode.ProviderResult<vscode.PreparedToolInvocation> {
		const what = options.input.text
			? `等待文本 "${options.input.text}" 出现`
			: `等待 ${options.input.seconds ?? 0} 秒`;
		return { invocationMessage: what };
	}
}

class CloseTool extends PwTool<Record<string, never>> {
	protected async run(): Promise<vscode.LanguageModelToolResult> {
		if (!this.manager.isRunning) {
			return textResult('Browser is not running.');
		}
		await this.manager.close();
		return textResult('Browser closed.');
	}

	prepareInvocation(): vscode.ProviderResult<vscode.PreparedToolInvocation> {
		return { invocationMessage: '关闭浏览器' };
	}
}

/** 注册全部 pw_* 工具;名字必须与 package.json 的 languageModelTools 声明一致。 */
export function registerTools(
	manager: BrowserManager,
	log: vscode.OutputChannel
): vscode.Disposable[] {
	const tools: Array<[string, vscode.LanguageModelTool<never>]> = [
		['pw_navigate', new NavigateTool(manager, log) as vscode.LanguageModelTool<never>],
		['pw_snapshot', new SnapshotTool(manager, log) as vscode.LanguageModelTool<never>],
		['pw_click', new ClickTool(manager, log) as vscode.LanguageModelTool<never>],
		['pw_type', new TypeTool(manager, log) as vscode.LanguageModelTool<never>],
		['pw_screenshot', new ScreenshotTool(manager, log) as vscode.LanguageModelTool<never>],
		['pw_wait', new WaitTool(manager, log) as vscode.LanguageModelTool<never>],
		['pw_close', new CloseTool(manager, log) as vscode.LanguageModelTool<never>],
	];
	return tools.map(([name, tool]) => vscode.lm.registerTool(name, tool));
}
