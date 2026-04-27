import * as vscode from 'vscode';
import { AgentContextWebviewProvider } from './agentContextProvider';

export function activate(context: vscode.ExtensionContext) {
	// Register Agent Context webview panel
	const agentContextProvider = new AgentContextWebviewProvider(context.extensionUri);
	
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(
			'agent-cockpit.agentContext',
			agentContextProvider
		)
	);

	// Register commands
	context.subscriptions.push(
		vscode.commands.registerCommand('agent-cockpit.refreshAgentContext', () => {
			agentContextProvider.refresh();
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('agent-cockpit.reviewCurrentFile', async () => {
			const editor = vscode.window.activeTextEditor;
			if (!editor) {
				vscode.window.showErrorMessage('No active editor. Open a file first.');
				return;
			}
			const document = editor.document;
			const content = document.getText();
			const uri = document.uri;
			
			vscode.window.withProgress({
				location: vscode.ProgressLocation.Notification,
				title: 'Reviewing current file...',
				cancellable: false
			}, async (progress) => {
				try {
					const result = await agentContextProvider.sendToGateway({
						prompt: `Review the following file for quality, security, and best practices. Provide inline feedback.\n\nFile: ${uri.fsPath}\n\n\`\`\`\n${content}\n\`\`\``,
						skill: 'code-reviewer',
						context: ''
					});
					
					vscode.window.showInformationMessage(`Review complete: ${result.slice(0, 100)}...`);
				} catch (error) {
					vscode.window.showErrorMessage(`Review failed: ${error instanceof Error ? error.message : String(error)}`);
				}
			});
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('agent-cockpit.reviewStagedDiff', async () => {
			try {
				const { execSync } = require('child_process');
				const diff = execSync('git diff --cached', { encoding: 'utf-8' });
				
				if (!diff.trim()) {
					vscode.window.showWarningMessage('No staged changes to review.');
					return;
				}

				const result = await agentContextProvider.sendToGateway({
					prompt: `Review the following staged diff for quality, security, and best practices.\n\n\`\`\`\n${diff}\n\`\`\``,
					skill: 'code-reviewer',
					context: ''
				});
				
				vscode.window.showInformationMessage(`Staged diff review complete: ${result.slice(0, 100)}...`);
			} catch (error) {
				vscode.window.showErrorMessage(`Failed to get staged diff: ${error instanceof Error ? error.message : String(error)}`);
			}
		})
	);
}

export function deactivate() {}
