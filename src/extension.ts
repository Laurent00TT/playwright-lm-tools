import * as vscode from 'vscode';
import { BrowserManager } from './browserManager';
import { registerTools } from './tools';

let manager: BrowserManager | undefined;

export function activate(context: vscode.ExtensionContext): void {
	manager = new BrowserManager();
	const log = vscode.window.createOutputChannel('Playwright LM Tools');
	context.subscriptions.push(log, ...registerTools(manager, log));
}

export async function deactivate(): Promise<void> {
	await manager?.close();
	manager = undefined;
}
