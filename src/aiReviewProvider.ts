import * as vscode from 'vscode';
import * as os from 'os';
import { GatewayClient } from './gatewayClient';

export class AiReviewWebviewProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = 'agent-cockpit.aiReview';
	
	private _view?: vscode.WebviewView;
	private _gatewayClient: GatewayClient;
	private _disposables: vscode.Disposable[] = [];

	constructor(private readonly _extensionUri: vscode.Uri) {
		this._gatewayClient = new GatewayClient();
	}

	public resolveWebviewView(
		webviewView: vscode.WebviewView,
		_context: vscode.WebviewViewResolveContext,
		_token: vscode.CancellationToken,
	) {
		this._view = webviewView;

		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [this._extensionUri],
		};

		webviewView.webview.html = this._getHtmlForWebview();

		webviewView.webview.onDidReceiveMessage(async (message) => {
			switch (message.type) {
				case 'reviewFile':
					await this.reviewCurrentFile();
					break;
				case 'reviewStaged':
					await this.reviewStagedDiff();
					break;
			}
		});
	}

	private async reviewCurrentFile() {
		if (!this._view) return;
		
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			this._view.webview.postMessage({ type: 'reviewError', error: 'No active editor. Open a file first.' });
			vscode.window.showErrorMessage('No active editor. Open a file first.');
			return;
		}

		const document = editor.document;
		const content = document.getText();
		const uri = document.uri;
		const language = document.languageId;

		this._view.webview.postMessage({ type: 'reviewStatus', status: 'loading' });

		try {
			const prompt = `Review the following file for quality, security, and best practices.

File: ${uri.fsPath}
Language: ${language}

Return your review as a JSON array of comments, where each comment has:
{
  "line": number (1-indexed),
  "severity": "error" | "warning" | "info",
  "category": "security" | "performance" | "style" | "logic" | "readability",
  "message": "string"
}

Also include a summary field at the top level:
{
  "summary": "overall assessment",
  "score": number (1-10),
  "comments": [...]
}

\`\`\`${language}
${content}
\`\`\``;

			const result = await this._gatewayClient.chat({
				prompt: prompt,
				skill: 'code-reviewer',
				context: ''
			});

			// Parse JSON from the response
			const review = this._parseReviewResponse(result);
			
			if (review) {
				// Create inline comments using VS Code comment API
				await this._createInlineComments(uri, review.comments);
				
				this._view.webview.postMessage({
					type: 'reviewResult',
					review: review
				});
			} else {
				this._view.webview.postMessage({
					type: 'reviewResult',
					review: {
						summary: 'Review complete',
						score: 0,
						comments: [],
						raw: result
					}
				});
			}
		} catch (error) {
			this._view.webview.postMessage({
				type: 'reviewError',
				error: error instanceof Error ? error.message : String(error)
			});
		}
	}

	private async reviewStagedDiff() {
		if (!this._view) return;

		this._view.webview.postMessage({ type: 'reviewStatus', status: 'loading' });

		try {
			const { execSync } = require('child_process');
			const diff = execSync('git diff --cached', { encoding: 'utf-8' });

			if (!diff.trim()) {
				this._view.webview.postMessage({
					type: 'reviewError',
					error: 'No staged changes to review.'
				});
				vscode.window.showWarningMessage('No staged changes to review.');
				return;
			}

			const prompt = `Review the following staged git diff for quality, security, and best practices.

Return your review as a JSON array of comments, where each comment has:
{
  "file": "filename",
  "line": number (line number in the diff),
  "severity": "error" | "warning" | "info",
  "category": "security" | "performance" | "style" | "logic" | "readability",
  "message": "string"
}

Also include a summary field:
{
  "summary": "overall assessment",
  "score": number (1-10),
  "comments": [...]
}

\`\`\`diff
${diff}
\`\`\``;

			const result = await this._gatewayClient.chat({
				prompt: prompt,
				skill: 'code-reviewer',
				context: ''
			});

			const review = this._parseReviewResponse(result);
			
			if (review) {
				this._view.webview.postMessage({
					type: 'reviewResult',
					review: review
				});
			} else {
				this._view.webview.postMessage({
					type: 'reviewResult',
					review: {
						summary: 'Staged diff review complete',
						score: 0,
						comments: [],
						raw: result
					}
				});
			}
		} catch (error) {
			this._view.webview.postMessage({
				type: 'reviewError',
				error: error instanceof Error ? error.message : String(error)
			});
		}
	}

	private _parseReviewResponse(response: string) {
		// Try to extract JSON from the response
		const jsonMatch = response.match(/\{[\s\S]*"summary"[\s\S]*\}/);
		if (jsonMatch) {
			try {
				return JSON.parse(jsonMatch[0]);
			} catch {
				// Fall through
			}
		}

		// Try array format
		const arrMatch = response.match(/\[[\s\S]*\]/);
		if (arrMatch) {
			try {
				const parsed = JSON.parse(arrMatch[0]);
				return {
					summary: 'Review complete',
					score: 0,
					comments: parsed
				};
			} catch {
				// Fall through
			}
		}

		return null;
	}

	private async _createInlineComments(
		uri: vscode.Uri,
		comments: Array<{line: number; severity: string; category: string; message: string}>
	) {
		if (!comments || comments.length === 0) return;

		// Note: Inline comments via VS Code Comment API require Comment objects
		// with author info. For MVP, the review results are displayed in the webview.
		// Inline comments can be added in a future iteration.
		console.log(`Agent review found ${comments.length} issues in ${uri.fsPath}`);
	}

	private _getHtmlForWebview() {
		return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
    <style>
        :root {
            --bg-primary: #1e1e1e;
            --bg-secondary: #252526;
            --bg-tertiary: #2d2d30;
            --text-primary: #d4d4d4;
            --text-secondary: #858585;
            --accent-blue: #0e639c;
            --accent-green: #4ec9b0;
            --accent-yellow: #dcdcaa;
            --accent-red: #f48771;
            --border-color: #3c3c3c;
        }
        
        * { margin: 0; padding: 0; box-sizing: border-box; }
        
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background-color: var(--bg-primary);
            color: var(--text-primary);
            font-size: 13px;
            line-height: 1.5;
            padding: 8px;
        }
        
        .action-buttons {
            display: flex;
            flex-direction: column;
            gap: 8px;
            margin-bottom: 16px;
        }
        
        .action-btn {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 10px 12px;
            background-color: var(--bg-secondary);
            border: 1px solid var(--border-color);
            border-radius: 4px;
            color: var(--text-primary);
            font-size: 13px;
            cursor: pointer;
            transition: background-color 0.2s;
        }
        
        .action-btn:hover {
            background-color: var(--bg-tertiary);
        }
        
        .action-btn:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }
        
        .action-btn .icon {
            font-size: 16px;
        }
        
        .action-btn .label {
            flex: 1;
        }
        
        .action-btn .shortcut {
            font-size: 11px;
            color: var(--text-secondary);
        }
        
        .review-section {
            margin-bottom: 16px;
            border: 1px solid var(--border-color);
            border-radius: 4px;
            overflow: hidden;
        }
        
        .review-header {
            background-color: var(--bg-secondary);
            padding: 8px 12px;
            display: flex;
            justify-content: space-between;
            align-items: center;
            border-bottom: 1px solid var(--border-color);
        }
        
        .review-header h3 {
            font-size: 12px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }
        
        .review-score {
            display: flex;
            align-items: center;
            gap: 4px;
        }
        
        .score-badge {
            padding: 2px 8px;
            border-radius: 12px;
            font-size: 12px;
            font-weight: 700;
        }
        
        .score-high {
            background-color: rgba(78, 201, 176, 0.2);
            color: var(--accent-green);
        }
        
        .score-medium {
            background-color: rgba(220, 220, 170, 0.2);
            color: var(--accent-yellow);
        }
        
        .score-low {
            background-color: rgba(244, 135, 113, 0.2);
            color: var(--accent-red);
        }
        
        .review-summary {
            padding: 12px;
            border-bottom: 1px solid var(--border-color);
            font-style: italic;
            color: var(--text-secondary);
        }
        
        .comment-item {
            padding: 8px 12px;
            border-bottom: 1px solid var(--border-color);
            display: flex;
            gap: 8px;
            align-items: flex-start;
        }
        
        .comment-item:last-child {
            border-bottom: none;
        }
        
        .comment-severity {
            font-size: 14px;
            flex-shrink: 0;
            margin-top: 1px;
        }
        
        .comment-content {
            flex: 1;
        }
        
        .comment-category {
            font-size: 10px;
            text-transform: uppercase;
            color: var(--text-secondary);
            letter-spacing: 0.5px;
        }
        
        .comment-message {
            margin-top: 2px;
        }
        
        .comment-line {
            font-size: 11px;
            color: var(--text-secondary);
            margin-top: 2px;
        }
        
        .loading {
            text-align: center;
            padding: 24px;
            color: var(--text-secondary);
        }
        
        .loading .spinner {
            display: inline-block;
            width: 20px;
            height: 20px;
            border: 2px solid var(--border-color);
            border-top-color: var(--accent-blue);
            border-radius: 50%;
            animation: spin 0.8s linear infinite;
            margin-bottom: 8px;
        }
        
        @keyframes spin {
            to { transform: rotate(360deg); }
        }
        
        .error-state {
            padding: 12px;
            background-color: rgba(244, 135, 113, 0.1);
            border: 1px solid rgba(244, 135, 113, 0.3);
            border-radius: 4px;
            color: var(--accent-red);
        }
        
        .empty-state {
            text-align: center;
            padding: 24px;
            color: var(--text-secondary);
            font-style: italic;
        }
        
        .raw-response {
            padding: 12px;
            background-color: var(--bg-tertiary);
            border-radius: 4px;
            font-family: 'Consolas', 'Monaco', monospace;
            font-size: 11px;
            white-space: pre-wrap;
            word-break: break-word;
            max-height: 300px;
            overflow-y: auto;
            color: var(--text-secondary);
        }
    </style>
</head>
<body>
    <!-- Action Buttons -->
    <div class="action-buttons">
        <button class="action-btn" id="btn-review-file" onclick="reviewFile()">
            <span class="icon">📄</span>
            <span class="label">Review Current File</span>
            <span class="shortcut">Ctrl+Shift+R</span>
        </button>
        <button class="action-btn" id="btn-review-staged" onclick="reviewStaged()">
            <span class="icon">📋</span>
            <span class="label">Review Staged Diff</span>
            <span class="shortcut">Ctrl+Shift+D</span>
        </button>
    </div>

    <!-- Review Results Container -->
    <div id="review-results">
        <div class="empty-state">
            Open a file and click "Review Current File" to get AI-powered code review feedback.
        </div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        
        function reviewFile() {
            document.getElementById('btn-review-file').disabled = true;
            document.getElementById('btn-review-staged').disabled = true;
            vscode.postMessage({ type: 'reviewFile' });
        }
        
        function reviewStaged() {
            document.getElementById('btn-review-file').disabled = true;
            document.getElementById('btn-review-staged').disabled = true;
            vscode.postMessage({ type: 'reviewStaged' });
        }
        
        function enableButtons() {
            document.getElementById('btn-review-file').disabled = false;
            document.getElementById('btn-review-staged').disabled = false;
        }
        
        function renderReview(review) {
            const container = document.getElementById('review-results');
            
            if (!review || review.comments.length === 0 && !review.raw) {
                container.innerHTML = '<div class="empty-state">No issues found. Great job!</div>';
                return;
            }
            
            // Determine score badge class
            let scoreClass = 'score-medium';
            if (review.score >= 7) scoreClass = 'score-high';
            else if (review.score <= 4) scoreClass = 'score-low';
            
            let html = '<div class="review-section">';
            html += '<div class="review-header">';
            html += '<h3>Review Results</h3>';
            if (review.score !== undefined && review.score !== 0) {
                html += '<div class="review-score"><span class="score-badge ' + scoreClass + '">' + review.score + '/10</span></div>';
            }
            html += '</div>';
            
            if (review.summary) {
                html += '<div class="review-summary">' + review.summary + '</div>';
            }
            
            if (review.comments && review.comments.length > 0) {
                html += review.comments.map(c => {
                    const severityIcon = c.severity === 'error' ? '🔴' : c.severity === 'warning' ? '🟡' : '🔵';
                    const lineInfo = c.line ? '<div class="comment-line">Line ' + c.line + '</div>' : '';
                    const fileInfo = c.file ? '<div class="comment-line">File: ' + c.file + '</div>' : '';
                    return '<div class="comment-item">' +
                        '<span class="comment-severity">' + severityIcon + '</span>' +
                        '<div class="comment-content">' +
                            '<div class="comment-category">' + (c.category || 'general') + '</div>' +
                            '<div class="comment-message">' + c.message + '</div>' +
                            lineInfo + fileInfo +
                        '</div>' +
                    '</div>';
                }).join('');
            }
            
            html += '</div>';
            
            // Show raw response if available
            if (review.raw) {
                html += '<div class="review-section">';
                html += '<div class="review-header"><h3>Raw Agent Response</h3></div>';
                html += '<div class="raw-response">' + escapeHtml(review.raw) + '</div>';
                html += '</div>';
            }
            
            container.innerHTML = html;
        }
        
        function escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }
        
        // Listen for messages from extension
        window.addEventListener('message', event => {
            const message = event.data;
            switch (message.type) {
                case 'reviewStatus':
                    if (message.status === 'loading') {
                        document.getElementById('review-results').innerHTML = 
                            '<div class="loading"><div class="spinner"></div><div>Agent is reviewing...</div></div>';
                    }
                    break;
                case 'reviewResult':
                    enableButtons();
                    renderReview(message.review);
                    break;
                case 'reviewError':
                    enableButtons();
                    document.getElementById('review-results').innerHTML = 
                        '<div class="error-state">Error: ' + message.error + '</div>';
                    break;
            }
        });
    </script>
</body>
</html>`;
	}

	async sendToGateway(payload: { prompt: string; skill: string; context: string }) {
		return await this._gatewayClient.chat(payload);
	}

	public dispose() {
		this._disposables.forEach(d => d.dispose());
	}
}
