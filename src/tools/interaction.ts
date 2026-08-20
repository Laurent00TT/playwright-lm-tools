import * as fs from 'node:fs/promises';
import type { Page } from 'playwright-core';
import * as vscode from 'vscode';
import { PwTool, firstLine, raceCancellation, settle, throwIfCancelled } from '../toolBase';

interface ClickInput {
	ref: string;
	element: string;
}

export class ClickTool extends PwTool<ClickInput> {
	protected async run(
		{ ref, element }: ClickInput,
		token: vscode.CancellationToken
	): Promise<vscode.LanguageModelToolResult> {
		const page = this.manager.requirePage();
		const locator = this.manager.refLocator(ref);
		// target=_blank 会开新标签,popup 事件要在点击前挂好等待器才追得上。
		// 探针必须限短超时:ref 失效时默认 30s 等待会把报错拖成 40s
		const opensTab = await locator
			.evaluate(
				(el) => {
					const anchor = el.closest('a');
					return !!anchor && anchor.target === '_blank';
				},
				undefined,
				{ timeout: 2_000 }
			)
			.catch(() => false);
		const popupPromise: Promise<Page | undefined> = opensTab
			? page.waitForEvent('popup', { timeout: this.manager.actionTimeout }).catch(() => undefined)
			: Promise.resolve(undefined);
		await this.act(locator.click({ timeout: this.manager.actionTimeout }), token);
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

export class TypeTool extends PwTool<TypeInput> {
	protected async run(
		input: TypeInput,
		token: vscode.CancellationToken
	): Promise<vscode.LanguageModelToolResult> {
		this.manager.requirePage();
		const timeout = this.manager.actionTimeout;
		const locator = this.manager.refLocator(input.ref);
		if (input.slowly) {
			await raceCancellation(locator.click({ timeout }), token);
			// 分块逐字输入并在块间检查取消/弹窗,Stop 后残留输入至多一个块
			for (const chunk of input.text.match(/.{1,8}/gs) ?? []) {
				throwIfCancelled(token);
				if (this.manager.pendingDialog) {
					break;
				}
				await locator.pressSequentially(chunk, { delay: 50, timeout });
			}
		} else {
			await this.act(locator.fill(input.text, { timeout }), token);
		}
		if (input.submit && !this.manager.pendingDialog) {
			throwIfCancelled(token);
			await this.act(locator.press('Enter', { timeout }), token);
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

interface HoverInput {
	ref: string;
	element: string;
}

export class HoverTool extends PwTool<HoverInput> {
	protected async run(
		{ ref, element }: HoverInput,
		token: vscode.CancellationToken
	): Promise<vscode.LanguageModelToolResult> {
		this.manager.requirePage();
		await this.act(
			this.manager.refLocator(ref).hover({ timeout: this.manager.actionTimeout }),
			token
		);
		// 悬停展开的菜单通常靠 JS/CSS 过渡,给一小拍再快照
		await new Promise<void>((resolve) => setTimeout(resolve, 300));
		return this.actionResult(`Hovered over "${element}" (ref=${ref})`);
	}

	prepareInvocation(
		options: vscode.LanguageModelToolInvocationPrepareOptions<HoverInput>
	): vscode.ProviderResult<vscode.PreparedToolInvocation> {
		return { invocationMessage: `悬停在 ${options.input.element}` };
	}
}

interface PressKeyInput {
	key: string;
	ref?: string;
	element?: string;
}

export class PressKeyTool extends PwTool<PressKeyInput> {
	protected async run(
		input: PressKeyInput,
		token: vscode.CancellationToken
	): Promise<vscode.LanguageModelToolResult> {
		if (!input.key) {
			throw new Error('Parameter "key" is required, e.g. "Escape", "Tab", "Control+A".');
		}
		const page = this.manager.requirePage();
		const timeout = this.manager.actionTimeout;
		if (input.ref) {
			await this.act(this.manager.refLocator(input.ref).press(input.key, { timeout }), token);
		} else {
			await this.act(page.keyboard.press(input.key), token);
		}
		await settle(this.manager);
		const where = input.element ? ` on "${input.element}"` : '';
		return this.actionResult(`Pressed ${input.key}${where}`);
	}

	prepareInvocation(
		options: vscode.LanguageModelToolInvocationPrepareOptions<PressKeyInput>
	): vscode.ProviderResult<vscode.PreparedToolInvocation> {
		return { invocationMessage: `按键 ${options.input.key}` };
	}
}

interface SelectOptionInput {
	ref: string;
	element: string;
	values: string[];
}

export class SelectOptionTool extends PwTool<SelectOptionInput> {
	protected async run(
		input: SelectOptionInput,
		token: vscode.CancellationToken
	): Promise<vscode.LanguageModelToolResult> {
		if (!input.values?.length) {
			throw new Error('Parameter "values" must contain at least one option.');
		}
		this.manager.requirePage();
		const locator = this.manager.refLocator(input.ref);
		const half = Math.max(2_000, this.manager.actionTimeout / 2);
		try {
			// 快照展示的是选项文本,先按 label 匹配(act:选择可能触发 onchange 弹窗)
			await this.act(
				locator.selectOption(
					input.values.map((v) => ({ label: v })),
					{ timeout: half }
				),
				token
			);
		} catch (err) {
			if (err instanceof vscode.CancellationError || this.manager.pendingDialog) {
				throw err;
			}
			// label 未命中再按 value 属性匹配
			await this.act(locator.selectOption(input.values, { timeout: half }), token);
		}
		await settle(this.manager);
		return this.actionResult(
			`Selected [${input.values.join(', ')}] in "${input.element}"`
		);
	}

	prepareInvocation(
		options: vscode.LanguageModelToolInvocationPrepareOptions<SelectOptionInput>
	): vscode.ProviderResult<vscode.PreparedToolInvocation> {
		return { invocationMessage: `选择 ${options.input.values.join(', ')}` };
	}
}

interface UploadInput {
	ref: string;
	element: string;
	paths: string[];
}

export class UploadTool extends PwTool<UploadInput> {
	protected async run(
		input: UploadInput,
		token: vscode.CancellationToken
	): Promise<vscode.LanguageModelToolResult> {
		if (!input.paths?.length) {
			throw new Error('Parameter "paths" must contain at least one absolute file path.');
		}
		for (const p of input.paths) {
			await fs.access(p).catch(() => {
				throw new Error(`File not found: ${p}`);
			});
		}
		const page = this.manager.requirePage();
		const timeout = this.manager.actionTimeout;
		const locator = this.manager.refLocator(input.ref);
		try {
			await raceCancellation(locator.setInputFiles(input.paths, { timeout }), token);
		} catch (err) {
			if (err instanceof vscode.CancellationError) {
				throw err;
			}
			// ref 可能是打开文件选择器的按钮而非 <input type=file>:改走 filechooser 拦截
			if (!/HTMLInputElement|input element/i.test(firstLine(err))) {
				throw err;
			}
			const chooserPromise = page.waitForEvent('filechooser', { timeout });
			chooserPromise.catch(() => {});
			await this.act(locator.click({ timeout }), token);
			if (this.manager.pendingDialog) {
				// 点击引出的是 JS 弹窗而不是文件选择器,别再空等 chooser 超时
				return this.actionResult(
					`Clicked "${input.element}" but a dialog appeared before any file chooser`
				);
			}
			const chooser = await raceCancellation(chooserPromise, token);
			await chooser.setFiles(input.paths);
		}
		await settle(this.manager);
		return this.actionResult(
			`Uploaded ${input.paths.length} file(s) to "${input.element}"`
		);
	}

	prepareInvocation(
		options: vscode.LanguageModelToolInvocationPrepareOptions<UploadInput>
	): vscode.ProviderResult<vscode.PreparedToolInvocation> {
		return { invocationMessage: `上传 ${options.input.paths?.length ?? 0} 个文件` };
	}
}

interface ScrollInput {
	direction?: 'up' | 'down';
	pixels?: number;
	ref?: string;
	element?: string;
}

export class ScrollTool extends PwTool<ScrollInput> {
	protected async run(
		input: ScrollInput,
		token: vscode.CancellationToken
	): Promise<vscode.LanguageModelToolResult> {
		const page = this.manager.requirePage();
		if (input.ref) {
			await raceCancellation(
				this.manager
					.refLocator(input.ref)
					.scrollIntoViewIfNeeded({ timeout: this.manager.actionTimeout }),
				token
			);
			return this.actionResult(
				`Scrolled "${input.element ?? input.ref}" into view`
			);
		}
		const pixels = Math.min(Math.max(input.pixels ?? 720, 1), 20_000);
		const delta = input.direction === 'up' ? -pixels : pixels;
		await raceCancellation(page.mouse.wheel(0, delta), token);
		// 给懒加载内容一点加载时间
		await raceCancellation(
			new Promise<void>((resolve) => setTimeout(resolve, 500)),
			token
		);
		return this.actionResult(
			`Scrolled ${input.direction === 'up' ? 'up' : 'down'} ${pixels}px`
		);
	}

	prepareInvocation(
		options: vscode.LanguageModelToolInvocationPrepareOptions<ScrollInput>
	): vscode.ProviderResult<vscode.PreparedToolInvocation> {
		const what = options.input.ref
			? `滚动到 ${options.input.element ?? options.input.ref}`
			: `${options.input.direction === 'up' ? '上' : '下'}滚 ${options.input.pixels ?? 720}px`;
		return { invocationMessage: what };
	}
}
