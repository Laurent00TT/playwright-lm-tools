import * as vscode from 'vscode';
import type { BrowserManager } from './browserManager';

export function textResult(text: string): vscode.LanguageModelToolResult {
	return new vscode.LanguageModelToolResult([
		new vscode.LanguageModelTextPart(text),
	]);
}

export function firstLine(err: unknown): string {
	return (err instanceof Error ? err.message : String(err)).split('\n')[0];
}

/** 错误统一转成给模型看的文本;ref 失效/超时时附带下一步建议。 */
export function describeError(err: unknown): string {
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

export function throwIfCancelled(token: vscode.CancellationToken): void {
	if (token.isCancellationRequested) {
		throw new vscode.CancellationError();
	}
}

/**
 * 让长耗时的 playwright 调用可被用户 Stop 打断。playwright 没有逐操作中止,
 * race 只保证工具及时返回;残留的浏览器动作由调用方在步骤间检查 token 来收敛。
 */
export async function raceCancellation<T>(
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
export async function settle(manager: BrowserManager): Promise<void> {
	await new Promise<void>((resolve) => setTimeout(resolve, 100));
	if (manager.pendingDialog) {
		return; // 弹窗挂起时页面 JS 被阻塞,等加载只会白等
	}
	try {
		const page = manager.requirePage();
		await page.waitForLoadState('load', { timeout: 5_000 });
	} catch {
		// 页面可能已关闭或仍在导航;由 actionResult 兜底
	}
}

/** 截图结果统一装配:路径文本 + (新版 VS Code)内联图片。 */
export function screenshotParts(file: string, data: Buffer, note?: string): unknown[] {
	const parts: unknown[] = [
		new vscode.LanguageModelTextPart(`${note ? note + '\n' : ''}Screenshot saved to ${file}`),
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
	return parts;
}

/**
 * 所有 pw_* 工具的公共骨架:弹窗门禁、取消语义、异常兜底转文本、
 * 统一的"操作结果 + 新快照"回复格式。
 */
export abstract class PwTool<T> implements vscode.LanguageModelTool<T> {
	/** 弹窗挂起时是否仍可运行(诊断/处理弹窗类工具为 true)。 */
	protected readonly worksWhileDialogOpen: boolean = false;

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
		const dialog = this.manager.pendingDialog;
		if (dialog && !this.worksWhileDialogOpen) {
			// 弹窗未处理时其他动作都会被页面阻塞,直接拦下并指路
			return textResult(
				`A ${dialog.type} dialog is open: "${dialog.message}". The page is blocked — call pw_handle_dialog (accept=true/false) before any other action.`
			);
		}
		throwIfCancelled(token);
		try {
			return await this.run(options.input, token);
		} catch (err) {
			// 用户按 Stop:按取消语义上抛,VS Code 丢弃结果,不算工具报错
			if (err instanceof vscode.CancellationError || token.isCancellationRequested) {
				throw new vscode.CancellationError();
			}
			// 动作被弹窗打断而超时:报弹窗真相,不报误导性的超时提示
			const nowDialog = this.manager.pendingDialog;
			if (nowDialog) {
				return textResult(
					`A ${nowDialog.type} dialog appeared: "${nowDialog.message}". The page is blocked — call pw_handle_dialog (accept=true/false). (Original error: ${firstLine(err)})`
				);
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

	/**
	 * 执行可能触发 JS 弹窗的动作:弹窗一出现立即返回(动作本身会被弹窗阻塞),
	 * 由 pageState 的弹窗通告接管后续。
	 */
	protected async act(
		action: Promise<unknown>,
		token: vscode.CancellationToken
	): Promise<void> {
		const waiter = this.manager.waitForDialog();
		try {
			await raceCancellation(Promise.race([action, waiter.promise]), token);
		} finally {
			waiter.dispose();
			action.catch(() => {});
		}
	}

	/** 操作结果统一格式:动作描述 + 当前 URL/标题 + 新快照,让模型无需追加调用。 */
	protected async pageState(header: string): Promise<string> {
		const dialog = this.manager.pendingDialog;
		if (dialog) {
			// 弹窗挂起时页面 JS 被阻塞,快照/标题都取不到,直接通告弹窗
			const hint =
				dialog.type === 'prompt'
					? ' (optionally pass promptText)'
					: '';
			return [
				header,
				'',
				`A ${dialog.type} dialog is open: "${dialog.message}"${dialog.defaultValue ? ` (default: "${dialog.defaultValue}")` : ''}`,
				`The page is blocked until it is handled. Call pw_handle_dialog with accept=true or accept=false${hint}.`,
			].join('\n');
		}
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
