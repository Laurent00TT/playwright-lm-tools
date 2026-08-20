import * as vscode from 'vscode';
import { PwTool, raceCancellation, textResult } from '../toolBase';

interface NavigateInput {
	url: string;
}

export class NavigateTool extends PwTool<NavigateInput> {
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
		// act():导航途中弹出的 beforeunload 之外的弹窗(如页面 onload alert)立即接管
		await this.act(
			page.goto(target, {
				waitUntil: 'domcontentloaded',
				timeout: this.manager.navigationTimeout,
			}),
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

export class BackTool extends PwTool<Record<string, never>> {
	protected async run(
		_input: Record<string, never>,
		token: vscode.CancellationToken
	): Promise<vscode.LanguageModelToolResult> {
		const page = this.manager.requirePage();
		// 手写竞速而不用 act():要保留 goBack 的 null(无历史)返回值,
		// 弹窗命中(undefined)与无历史(null)靠 pendingDialog 区分
		const waiter = this.manager.waitForDialog();
		let response: Awaited<ReturnType<typeof page.goBack>> | undefined;
		try {
			response = await raceCancellation(
				Promise.race([
					page.goBack({
						waitUntil: 'domcontentloaded',
						timeout: this.manager.navigationTimeout,
					}),
					waiter.promise.then(() => undefined),
				]),
				token
			);
		} finally {
			waiter.dispose();
		}
		if (this.manager.pendingDialog) {
			return this.actionResult('Back navigation was interrupted by a dialog');
		}
		if (response === null) {
			return textResult('Cannot go back — no previous page in history.');
		}
		return this.actionResult('Navigated back');
	}

	prepareInvocation(): vscode.ProviderResult<vscode.PreparedToolInvocation> {
		return { invocationMessage: '返回上一页' };
	}
}

interface WaitInput {
	seconds?: number;
	text?: string;
}

export class WaitTool extends PwTool<WaitInput> {
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

interface ResizeInput {
	width: number;
	height: number;
}

export class ResizeTool extends PwTool<ResizeInput> {
	protected async run(
		{ width, height }: ResizeInput,
		token: vscode.CancellationToken
	): Promise<vscode.LanguageModelToolResult> {
		if (!width || !height || width < 100 || height < 100 || width > 5000 || height > 5000) {
			throw new Error('width/height must be between 100 and 5000 pixels.');
		}
		const page = this.manager.requirePage();
		await raceCancellation(page.setViewportSize({ width, height }), token);
		// 响应式布局切换需要一拍重排
		await new Promise<void>((resolve) => setTimeout(resolve, 300));
		return this.actionResult(`Resized viewport to ${width}x${height}`);
	}

	prepareInvocation(
		options: vscode.LanguageModelToolInvocationPrepareOptions<ResizeInput>
	): vscode.ProviderResult<vscode.PreparedToolInvocation> {
		return {
			invocationMessage: `调整视口为 ${options.input.width}x${options.input.height}`,
		};
	}
}

export class CloseTool extends PwTool<Record<string, never>> {
	protected override readonly worksWhileDialogOpen = true;

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
