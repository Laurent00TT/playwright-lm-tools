import * as vscode from 'vscode';
import { PwTool, textResult } from '../toolBase';

interface StateInput {
	name?: string;
}

export class SaveStateTool extends PwTool<StateInput> {
	protected async run(input: StateInput): Promise<vscode.LanguageModelToolResult> {
		const file = await this.manager.saveState(input.name ?? 'default');
		return textResult(
			`Storage state (cookies + localStorage) saved to ${file}. Restore it in a later session with pw_load_state.`
		);
	}

	prepareInvocation(
		options: vscode.LanguageModelToolInvocationPrepareOptions<StateInput>
	): vscode.ProviderResult<vscode.PreparedToolInvocation> {
		return { invocationMessage: `保存登录态 (${options.input.name ?? 'default'})` };
	}
}

export class LoadStateTool extends PwTool<StateInput> {
	protected async run(input: StateInput): Promise<vscode.LanguageModelToolResult> {
		const file = await this.manager.loadState(input.name ?? 'default');
		return textResult(
			`Storage state restored from ${file}. A fresh browser context is now active — use pw_navigate to open the app (previous login should be in effect).`
		);
	}

	prepareInvocation(
		options: vscode.LanguageModelToolInvocationPrepareOptions<StateInput>
	): vscode.ProviderResult<vscode.PreparedToolInvocation> {
		return { invocationMessage: `恢复登录态 (${options.input.name ?? 'default'})` };
	}
}
