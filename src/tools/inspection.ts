import * as vscode from 'vscode';
import { PwTool, firstLine, raceCancellation, screenshotParts, textResult } from '../toolBase';

export class SnapshotTool extends PwTool<Record<string, never>> {
	protected async run(): Promise<vscode.LanguageModelToolResult> {
		return textResult(await this.pageState('Captured page snapshot'));
	}

	prepareInvocation(): vscode.ProviderResult<vscode.PreparedToolInvocation> {
		return { invocationMessage: '抓取页面快照' };
	}
}

interface ScreenshotInput {
	fullPage?: boolean;
}

export class ScreenshotTool extends PwTool<ScreenshotInput> {
	protected async run(input: ScreenshotInput): Promise<vscode.LanguageModelToolResult> {
		const { file, data } = await this.manager.screenshot(!!input.fullPage);
		return new vscode.LanguageModelToolResult(
			screenshotParts(file, data) as vscode.LanguageModelTextPart[]
		);
	}

	prepareInvocation(): vscode.ProviderResult<vscode.PreparedToolInvocation> {
		return { invocationMessage: '截取页面截图' };
	}
}

interface VerifyInput {
	assertion: 'text_visible' | 'element_visible' | 'value';
	text?: string;
	ref?: string;
	element?: string;
	expected?: string;
}

const VERIFY_TIMEOUT = 5_000;

export class VerifyTool extends PwTool<VerifyInput> {
	protected async run(
		input: VerifyInput,
		token: vscode.CancellationToken
	): Promise<vscode.LanguageModelToolResult> {
		const page = this.manager.requirePage();
		let pass: boolean;
		let detail: string;

		switch (input.assertion) {
			case 'text_visible': {
				if (!input.text) {
					throw new Error('"text" is required for assertion=text_visible.');
				}
				try {
					await raceCancellation(
						page
							.getByText(input.text)
							.filter({ visible: true })
							.first()
							.waitFor({ state: 'visible', timeout: VERIFY_TIMEOUT }),
						token
					);
					pass = true;
					detail = `text "${input.text}" is visible`;
				} catch (err) {
					if (err instanceof vscode.CancellationError) {
						throw err;
					}
					pass = false;
					detail = `text "${input.text}" did not become visible within ${VERIFY_TIMEOUT / 1000}s`;
				}
				break;
			}
			case 'element_visible': {
				if (!input.ref) {
					throw new Error('"ref" is required for assertion=element_visible.');
				}
				try {
					await raceCancellation(
						this.manager
							.refLocator(input.ref)
							.waitFor({ state: 'visible', timeout: VERIFY_TIMEOUT }),
						token
					);
					pass = true;
					detail = `element "${input.element ?? input.ref}" is visible`;
				} catch (err) {
					if (err instanceof vscode.CancellationError) {
						throw err;
					}
					pass = false;
					detail = `element "${input.element ?? input.ref}" is not visible (${VERIFY_TIMEOUT / 1000}s). If the ref is stale, take pw_snapshot and retry.`;
				}
				break;
			}
			case 'value': {
				if (!input.ref || input.expected === undefined) {
					throw new Error('"ref" and "expected" are required for assertion=value.');
				}
				const actual = await raceCancellation(
					this.manager.refLocator(input.ref).inputValue({ timeout: VERIFY_TIMEOUT }),
					token
				);
				pass = actual === input.expected;
				detail = `element "${input.element ?? input.ref}": expected value "${input.expected}", actual "${actual}"`;
				break;
			}
			default:
				throw new Error(
					`Unknown assertion "${String(input.assertion)}". Use text_visible, element_visible or value.`
				);
		}

		const verdict = pass ? 'PASS' : 'FAIL';
		const summary = `${verdict}: ${detail}\nPage URL: ${page.url()}`;
		const withScreenshot = vscode.workspace
			.getConfiguration('pwTools')
			.get<boolean>('screenshotOnVerifyFail', true);
		if (!pass && withScreenshot) {
			// 断言失败自动截图取证
			try {
				const { file, data } = await this.manager.screenshot(false);
				return new vscode.LanguageModelToolResult(
					screenshotParts(file, data, summary) as vscode.LanguageModelTextPart[]
				);
			} catch {
				// 截图失败不影响断言结论
			}
		}
		return textResult(summary);
	}

	prepareInvocation(
		options: vscode.LanguageModelToolInvocationPrepareOptions<VerifyInput>
	): vscode.ProviderResult<vscode.PreparedToolInvocation> {
		const i = options.input;
		const what =
			i.assertion === 'text_visible'
				? `文本 "${i.text}" 可见`
				: i.assertion === 'value'
					? `${i.element ?? i.ref} 的值为 "${i.expected}"`
					: `${i.element ?? i.ref} 可见`;
		return { invocationMessage: `断言:${what}` };
	}
}

interface ConsoleInput {
	onlyErrors?: boolean;
	clear?: boolean;
}

export class ConsoleTool extends PwTool<ConsoleInput> {
	protected override readonly worksWhileDialogOpen = true;

	protected async run(input: ConsoleInput): Promise<vscode.LanguageModelToolResult> {
		this.manager.requirePage();
		const entries = this.manager.consoleEntries(!!input.onlyErrors);
		if (input.clear) {
			this.manager.clearConsole();
		}
		if (!entries.length) {
			return textResult(
				input.onlyErrors ? 'No console errors recorded.' : 'No console messages recorded.'
			);
		}
		const shown = entries.slice(-100);
		const lines = shown.map((e) => `[${e.time}] [${e.level}] ${e.text}`);
		const omitted =
			entries.length > shown.length ? `(${entries.length - shown.length} older entries omitted)\n` : '';
		return textResult(`${omitted}${lines.join('\n')}`);
	}

	prepareInvocation(): vscode.ProviderResult<vscode.PreparedToolInvocation> {
		return { invocationMessage: '读取控制台消息' };
	}
}

interface NetworkInput {
	urlFilter?: string;
	id?: number;
}

const BODY_SNIPPET_LIMIT = 2_000;

export class NetworkTool extends PwTool<NetworkInput> {
	protected override readonly worksWhileDialogOpen = true;

	protected async run(input: NetworkInput): Promise<vscode.LanguageModelToolResult> {
		this.manager.requirePage();
		if (input.id !== undefined) {
			return this.details(input.id);
		}
		const entries = this.manager.networkEntries(input.urlFilter);
		if (!entries.length) {
			return textResult(
				input.urlFilter
					? `No recorded requests match "${input.urlFilter}".`
					: 'No network requests recorded yet.'
			);
		}
		const shown = entries.slice(-100);
		const lines = shown.map((e) => {
			const status = e.failure ? `FAILED(${e.failure})` : (e.status ?? 'pending');
			return `#${e.id} ${e.method} ${status} ${e.url}`;
		});
		const omitted =
			entries.length > shown.length ? `(${entries.length - shown.length} older entries omitted)\n` : '';
		return textResult(
			`${omitted}${lines.join('\n')}\n\nPass "id" to get headers and response body for one request.`
		);
	}

	private async details(id: number): Promise<vscode.LanguageModelToolResult> {
		const entry = this.manager.networkEntry(id);
		if (!entry) {
			throw new Error(`No recorded request with id ${id}. List requests first.`);
		}
		const lines = [
			`#${entry.id} ${entry.method} ${entry.url}`,
			`Resource type: ${entry.resourceType}`,
			`Status: ${entry.failure ? `FAILED (${entry.failure})` : (entry.status ?? 'pending')}`,
		];
		if (entry.response) {
			const headers = await entry.response.allHeaders().catch(() => ({}) as Record<string, string>);
			const contentType = headers['content-type'] ?? '';
			lines.push(`Content-Type: ${contentType || '(unknown)'}`);
			if (/event-stream/i.test(contentType)) {
				// SSE/长轮询的 body 永不 finish,text() 会永久挂死(实测),绝不能等
				lines.push('(streaming response — body not captured)');
			} else if (/json|text|xml|javascript|urlencoded/i.test(contentType)) {
				// 未完成的响应 text() 不会 settle,限 3s 优雅降级
				const bodyPromise = entry.response.text();
				const body = await Promise.race([
					bodyPromise.catch((e) => `(body unavailable: ${firstLine(e)})`),
					new Promise<string>((resolve) =>
						setTimeout(
							() => resolve('(body not available yet — response still in flight)'),
							3_000
						)
					),
				]);
				bodyPromise.catch(() => {});
				lines.push(
					'',
					'Response body:',
					body.length > BODY_SNIPPET_LIMIT
						? body.slice(0, BODY_SNIPPET_LIMIT) + `… [truncated at ${BODY_SNIPPET_LIMIT} chars]`
						: body
				);
			} else {
				lines.push('(binary/non-text response body omitted)');
			}
		}
		return textResult(lines.join('\n'));
	}

	prepareInvocation(
		options: vscode.LanguageModelToolInvocationPrepareOptions<NetworkInput>
	): vscode.ProviderResult<vscode.PreparedToolInvocation> {
		return {
			invocationMessage:
				options.input.id !== undefined
					? `查看请求 #${options.input.id} 详情`
					: '列出网络请求',
		};
	}
}
