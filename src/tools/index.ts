import * as vscode from 'vscode';
import type { BrowserManager } from '../browserManager';
import { HandleDialogTool } from './dialogs';
import { ConsoleTool, NetworkTool, ScreenshotTool, SnapshotTool, VerifyTool } from './inspection';
import {
	ClickTool,
	HoverTool,
	PressKeyTool,
	ScrollTool,
	SelectOptionTool,
	TypeTool,
	UploadTool,
} from './interaction';
import { BackTool, CloseTool, NavigateTool, ResizeTool, WaitTool } from './navigation';
import { LoadStateTool, SaveStateTool } from './session';

/** 注册全部 pw_* 工具;名字必须与 package.json 的 languageModelTools 声明一致。 */
export function registerTools(
	manager: BrowserManager,
	log: vscode.OutputChannel
): vscode.Disposable[] {
	const entries: Array<[string, unknown]> = [
		['pw_navigate', new NavigateTool(manager, log)],
		['pw_snapshot', new SnapshotTool(manager, log)],
		['pw_click', new ClickTool(manager, log)],
		['pw_type', new TypeTool(manager, log)],
		['pw_screenshot', new ScreenshotTool(manager, log)],
		['pw_wait', new WaitTool(manager, log)],
		['pw_close', new CloseTool(manager, log)],
		['pw_verify', new VerifyTool(manager, log)],
		['pw_console', new ConsoleTool(manager, log)],
		['pw_handle_dialog', new HandleDialogTool(manager, log)],
		['pw_select_option', new SelectOptionTool(manager, log)],
		['pw_press_key', new PressKeyTool(manager, log)],
		['pw_hover', new HoverTool(manager, log)],
		['pw_upload', new UploadTool(manager, log)],
		['pw_network', new NetworkTool(manager, log)],
		['pw_save_state', new SaveStateTool(manager, log)],
		['pw_load_state', new LoadStateTool(manager, log)],
		['pw_resize', new ResizeTool(manager, log)],
		['pw_scroll', new ScrollTool(manager, log)],
		['pw_back', new BackTool(manager, log)],
	];
	return entries.map(([name, tool]) =>
		vscode.lm.registerTool(name, tool as vscode.LanguageModelTool<never>)
	);
}
