import * as vscode from 'vscode';
import { PwTool, settle } from '../toolBase';

interface HandleDialogInput {
	accept: boolean;
	promptText?: string;
}

export class HandleDialogTool extends PwTool<HandleDialogInput> {
	protected override readonly worksWhileDialogOpen = true;

	protected async run(input: HandleDialogInput): Promise<vscode.LanguageModelToolResult> {
		if (input.accept === undefined) {
			throw new Error('Parameter "accept" (true/false) is required.');
		}
		const info = await this.manager.handleDialog(input.accept, input.promptText);
		await settle(this.manager);
		const action = input.accept ? 'Accepted' : 'Dismissed';
		const nextNote = info.next
			? ` Another dialog is already waiting (${info.next}) — handle it too.`
			: '';
		return this.actionResult(
			`${action} the ${info.type} dialog ("${info.message}").${nextNote}`
		);
	}

	prepareInvocation(
		options: vscode.LanguageModelToolInvocationPrepareOptions<HandleDialogInput>
	): vscode.ProviderResult<vscode.PreparedToolInvocation> {
		return {
			invocationMessage: options.input.accept ? '接受弹窗' : '取消弹窗',
		};
	}
}
