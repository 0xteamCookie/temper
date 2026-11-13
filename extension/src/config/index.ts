// Settings access for the extension host.
import * as vscode from 'vscode';
import { readSettings } from './settings';
import type { TemperSettings } from './settings';

export * from './settings';

/** Read the current temper.* settings from VS Code. */
export function getSettings(): TemperSettings {
  return readSettings(vscode.workspace.getConfiguration('temper'));
}
