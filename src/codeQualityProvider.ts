import * as vscode from 'vscode';
import { execSync } from 'child_process';
import * as os from 'os';

export class CodeQualityWebviewProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = 'agent-cockpit.codeQuality';
	
	private _view?: vscode.WebviewView;
	private _disposables: vscode.Disposable[] = [];
	private _sonarData: SonarResult | null = null;

	constructor(private readonly _extensionUri: vscode.Uri) {}

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
				case 'runSonar':
					await this.runSonarScan();
					break;
				case 'scanFile':
					await this.scanCurrentFile();
					break;
			}
		});

		// Auto-scan on file change
		vscode.workspace.onDidChangeTextDocument(async (event) => {
			const editor = vscode.window.activeTextEditor;
			if (editor && editor.document === event.document) {
				// Debounced auto-scan
				setTimeout(() => this.scanCurrentFile(), 2000);
			}
		});
	}

	async runSonarScan() {
		if (!this._view) return;

		this._view.webview.postMessage({ type: 'scanStatus', status: 'loading' });

		try {
			// Check if sonar-scanner is available
			const sonarScannerPath = this._findSonarScanner();
			if (!sonarScannerPath) {
				this._view.webview.postMessage({
					type: 'scanError',
					error: 'SonarScanner not found. Install it or configure the path in settings.'
				});
				return;
			}

			const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
			if (!workspaceRoot) {
				this._view.webview.postMessage({
					type: 'scanError',
					error: 'No workspace folder open.'
				});
				return;
			}

			// Run sonar-scanner
			const result = await this._executeSonarScan(sonarScannerPath, workspaceRoot.fsPath);
			
			if (result) {
				this._sonarData = result;
				this._view.webview.postMessage({
					type: 'scanResult',
					data: result
				});
			} else {
				this._view.webview.postMessage({
					type: 'scanError',
					error: 'SonarScanner completed but returned no results.'
				});
			}
		} catch (error) {
			this._view.webview.postMessage({
				type: 'scanError',
				error: error instanceof Error ? error.message : String(error)
			});
		}
	}

	async scanCurrentFile() {
		if (!this._view) return;

		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			this._view.webview.postMessage({
				type: 'scanError',
				error: 'No active editor. Open a file first.'
			});
			return;
		}

		this._view.webview.postMessage({ type: 'scanStatus', status: 'loading' });

		try {
			const document = editor.document;
			const content = document.getText();
			const uri = document.uri;
			const language = document.languageId;

			// Basic file analysis (no sonar-scanner needed)
			const analysis = this._analyzeFile(content, uri.fsPath, language);
			
			this._view.webview.postMessage({
				type: 'fileAnalysis',
				data: analysis
			});
		} catch (error) {
			this._view.webview.postMessage({
				type: 'scanError',
				error: error instanceof Error ? error.message : String(error)
			});
		}
	}

	private _findSonarScanner(): string | null {
		// Check common locations
		const possiblePaths = [
			'sonar-scanner',  // In PATH
			'/usr/local/bin/sonar-scanner',
			'/opt/sonar-scanner/bin/sonar-scanner',
			`${os.homedir()}/.sonar/scanner/bin/sonar-scanner`,
		];

		for (const path of possiblePaths) {
			try {
				execSync(`${path} --version`, { stdio: 'ignore' });
				return path;
			} catch {
				// Try next
			}
		}

		return null;
	}

	private async _executeSonarScan(scannerPath: string, workspacePath: string): Promise<SonarResult | null> {
		return new Promise((resolve) => {
			const { spawn } = require('child_process');
			const child = spawn(scannerPath, [
				'-Dsonar.projectKey=agent-cockpit',
				'-Dsonar.projectName=Agent Cockpit',
				`-Dsonar.sources=.`,
				`-Dsonar.working.directory=${workspacePath}/.sonar`,
				'-Dsonar.host.url=http://localhost:9000',
				'-Dsonar.login='
			], {
				cwd: workspacePath,
				env: { ...process.env }
			});

			let stdout = '';
			let stderr = '';

			child.stdout.on('data', (data: Buffer) => {
				stdout += data.toString();
			});

			child.stderr.on('data', (data: Buffer) => {
				stderr += data.toString();
			});

			child.on('close', (code: number) => {
				if (code !== 0) {
					// SonarQube server not available, return basic analysis
					resolve(this._parseBasicAnalysis(stdout));
					return;
				}

				// Try to parse sonar-scanner output
				const result = this._parseSonarOutput(stdout);
				resolve(result);
			});
		});
	}

	private _parseSonarOutput(output: string): SonarResult | null {
		// Parse sonar-scanner JSON output if available
		const jsonMatch = output.match(/\{[\s\S]*"totalIssues"[\s\S]*\}/);
		if (jsonMatch) {
			try {
				return JSON.parse(jsonMatch[0]);
			} catch {
				// Fall through
			}
		}

		// Basic parsing of sonar-scanner text output
		const bugs = (output.match(/bugs:\s*(\d+)/i) || [])[1] ? parseInt((output.match(/bugs:\s*(\d+)/i) || [])[1]) : 0;
		const vulnerabilities = (output.match(/vulnerabilities:\s*(\d+)/i) || [])[1] ? parseInt((output.match(/vulnerabilities:\s*(\d+)/i) || [])[1]) : 0;
		const codeSmells = (output.match(/code smells:\s*(\d+)/i) || [])[1] ? parseInt((output.match(/code smells:\s*(\d+)/i) || [])[1]) : 0;
		const coverage = (output.match(/coverage:\s*(\d+)%/i) || [])[1] ? parseInt((output.match(/coverage:\s*(\d+)%/i) || [])[1]) : 0;

		return {
			bugs,
			vulnerabilities,
			codeSmells,
			coverage,
			issues: []
		};
	}

	private _parseBasicAnalysis(output: string): SonarResult | null {
		// Parse basic metrics from sonar-scanner output
		const bugs = (output.match(/bugs:\s*(\d+)/i) || [])[1] ? parseInt((output.match(/bugs:\s*(\d+)/i) || [])[1]) : 0;
		const vulnerabilities = (output.match(/vulnerabilities:\s*(\d+)/i) || [])[1] ? parseInt((output.match(/vulnerabilities:\s*(\d+)/i) || [])[1]) : 0;
		const codeSmells = (output.match(/code smells:\s*(\d+)/i) || [])[1] ? parseInt((output.match(/code smells:\s*(\d+)/i) || [])[1]) : 0;
		const coverage = (output.match(/coverage:\s*(\d+)%/i) || [])[1] ? parseInt((output.match(/coverage:\s*(\d+)%/i) || [])[1]) : 0;

		return {
			bugs,
			vulnerabilities,
			codeSmells,
			coverage,
			issues: []
		};
	}

	private _analyzeFile(content: string, filePath: string, language: string): FileAnalysis {
		const lines = content.split('\n');
		const issues: FileIssue[] = [];

		// Basic static analysis rules
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			const lineNum = i + 1;

			// Security: console.log in production code
			if (line.includes('console.log') && !line.includes('//')) {
				issues.push({
					line: lineNum,
					severity: 'warning',
					category: 'security',
					message: 'Remove console.log before production'
				});
			}

			// Security: eval() usage
			if (line.includes('eval(')) {
				issues.push({
					line: lineNum,
					severity: 'error',
					category: 'security',
					message: 'Avoid eval() — use JSON.parse() or safer alternatives'
				});
			}

			// Security: TODO/FIXME comments
			if (line.includes('TODO') || line.includes('FIXME')) {
				issues.push({
					line: lineNum,
					severity: 'info',
					category: 'style',
					message: 'Address TODO/FIXME comment'
				});
			}

			// Performance: large array literals
			if (line.match(/^\s*const\s+\w+\s*=\s*\[[\s\S]{1000,}\]/)) {
				issues.push({
					line: lineNum,
					severity: 'warning',
					category: 'performance',
					message: 'Large array literal — consider loading from file'
				});
			}

			// Style: trailing whitespace
			if (line.match(/\s+$/)) {
				issues.push({
					line: lineNum,
					severity: 'info',
					category: 'style',
					message: 'Trailing whitespace'
				});
			}
		}

		// Calculate metrics
		const bugs = issues.filter(i => i.severity === 'error').length;
		const warnings = issues.filter(i => i.severity === 'warning').length;
		const info = issues.filter(i => i.severity === 'info').length;
		const linesOfCode = lines.filter(l => l.trim().length > 0).length;
		const commentLines = lines.filter(l => l.trim().startsWith('//') || l.trim().startsWith('*') || l.trim().startsWith('/*')).length;
		const coverage = linesOfCode > 0 ? Math.max(0, Math.round(100 - (bugs * 5 + warnings * 2 + info))) : 0;

		return {
			bugs,
			warnings,
			issues,
			linesOfCode,
			commentLines,
			coverage,
			filePath,
			language
		};
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
            gap: 8px;
            margin-bottom: 16px;
        }
        
        .action-btn {
            flex: 1;
            padding: 10px 12px;
            background-color: var(--bg-secondary);
            border: 1px solid var(--border-color);
            border-radius: 4px;
            color: var(--text-primary);
            font-size: 12px;
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
        
        .metrics-grid {
            display: grid;
            grid-template-columns: repeat(2, 1fr);
            gap: 8px;
            margin-bottom: 16px;
        }
        
        .metric-card {
            background-color: var(--bg-secondary);
            border: 1px solid var(--border-color);
            border-radius: 4px;
            padding: 12px;
            text-align: center;
        }
        
        .metric-value {
            font-size: 24px;
            font-weight: 700;
        }
        
        .metric-label {
            font-size: 11px;
            color: var(--text-secondary);
            text-transform: uppercase;
            margin-top: 4px;
        }
        
        .metric-bugs .metric-value { color: var(--accent-red); }
        .metric-warnings .metric-value { color: var(--accent-yellow); }
        .metric-coverage .metric-value { color: var(--accent-green); }
        .metric-issues .metric-value { color: var(--accent-blue); }
        
        .section {
            margin-bottom: 16px;
            border: 1px solid var(--border-color);
            border-radius: 4px;
            overflow: hidden;
        }
        
        .section-header {
            background-color: var(--bg-secondary);
            padding: 8px 12px;
            font-weight: 600;
            font-size: 12px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            border-bottom: 1px solid var(--border-color);
        }
        
        .section-content {
            padding: 12px;
        }
        
        .issue-item {
            padding: 8px 0;
            border-bottom: 1px solid var(--border-color);
            display: flex;
            gap: 8px;
            align-items: flex-start;
        }
        
        .issue-item:last-child {
            border-bottom: none;
        }
        
        .issue-severity {
            width: 8px;
            height: 8px;
            border-radius: 50%;
            flex-shrink: 0;
            margin-top: 4px;
        }
        
        .issue-error .issue-severity { background-color: var(--accent-red); }
        .issue-warning .issue-severity { background-color: var(--accent-yellow); }
        .issue-info .issue-severity { background-color: var(--accent-blue); }
        
        .issue-content {
            flex: 1;
        }
        
        .issue-message {
            font-size: 13px;
        }
        
        .issue-meta {
            font-size: 11px;
            color: var(--text-secondary);
            margin-top: 2px;
        }
        
        .empty-state {
            text-align: center;
            padding: 24px;
            color: var(--text-secondary);
            font-style: italic;
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
        
        .file-info {
            padding: 8px 12px;
            background-color: var(--bg-secondary);
            border: 1px solid var(--border-color);
            border-radius: 4px;
            margin-bottom: 16px;
            font-size: 11px;
            color: var(--text-secondary);
        }
        
        .file-path {
            color: var(--accent-blue);
            font-weight: 600;
        }
        
        .coverage-bar {
            width: 100%;
            height: 4px;
            background-color: var(--bg-tertiary);
            border-radius: 2px;
            margin-top: 4px;
            overflow: hidden;
        }
        
        .coverage-fill {
            height: 100%;
            background-color: var(--accent-green);
            border-radius: 2px;
            transition: width 0.3s ease;
        }
    </style>
</head>
<body>
    <!-- Action Buttons -->
    <div class="action-buttons">
        <button class="action-btn" id="btn-sonar" onclick="runSonar()">
            Run Sonar Scanner
        </button>
        <button class="action-btn" id="btn-scan" onclick="scanFile()">
            Scan Current File
        </button>
    </div>

    <!-- File Info -->
    <div class="file-info" id="file-info">
        No file open
    </div>

    <!-- Metrics Grid -->
    <div class="metrics-grid" id="metrics-grid">
        <div class="metric-card metric-bugs">
            <div class="metric-value" id="metric-bugs">0</div>
            <div class="metric-label">Bugs</div>
        </div>
        <div class="metric-card metric-warnings">
            <div class="metric-value" id="metric-warnings">0</div>
            <div class="metric-label">Warnings</div>
        </div>
        <div class="metric-card metric-coverage">
            <div class="metric-value" id="metric-coverage">0%</div>
            <div class="metric-label">Coverage</div>
        </div>
        <div class="metric-card metric-issues">
            <div class="metric-value" id="metric-issues">0</div>
            <div class="metric-label">Issues</div>
        </div>
    </div>

    <!-- Issues Section -->
    <div class="section">
        <div class="section-header">Issues</div>
        <div class="section-content" id="issues-container">
            <div class="empty-state">Open a file and click "Scan Current File" to analyze code quality.</div>
        </div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        
        function runSonar() {
            document.getElementById('btn-sonar').disabled = true;
            vscode.postMessage({ type: 'runSonar' });
        }
        
        function scanFile() {
            document.getElementById('btn-scan').disabled = true;
            vscode.postMessage({ type: 'scanFile' });
        }
        
        function enableButtons() {
            document.getElementById('btn-sonar').disabled = false;
            document.getElementById('btn-scan').disabled = false;
        }
        
        function updateMetrics(data) {
            document.getElementById('metric-bugs').textContent = data.bugs || 0;
            document.getElementById('metric-warnings').textContent = data.warnings || 0;
            document.getElementById('metric-coverage').textContent = (data.coverage || 0) + '%';
            document.getElementById('metric-issues').textContent = (data.issues || []).length;
            
            // Update file info
            if (data.filePath) {
                document.getElementById('file-info').innerHTML = 
                    '<span class="file-path">' + data.filePath.split('/').pop() + '</span> · ' + 
                    (data.language || 'unknown') + ' · ' + 
                    (data.linesOfCode || 0) + ' lines';
            }
        }
        
        function renderIssues(issues) {
            const container = document.getElementById('issues-container');
            
            if (!issues || issues.length === 0) {
                container.innerHTML = '<div class="empty-state">No issues found. Great job!</div>';
                return;
            }
            
            container.innerHTML = issues.map(issue => {
                const severityClass = 'issue-' + (issue.severity || 'info');
                const lineInfo = issue.line ? 'Line ' + issue.line : '';
                const categoryInfo = issue.category ? '[' + (issue.category || '').toUpperCase() + ']' : '';
                
                return '<div class="issue-item ' + severityClass + '">' +
                    '<div class="issue-severity"></div>' +
                    '<div class="issue-content">' +
                        '<div class="issue-message">' + issue.message + '</div>' +
                        '<div class="issue-meta">' + lineInfo + ' ' + categoryInfo + '</div>' +
                    '</div>' +
                '</div>';
            }).join('');
        }
        
        window.addEventListener('message', event => {
            const message = event.data;
            switch (message.type) {
                case 'scanStatus':
                    if (message.status === 'loading') {
                        document.getElementById('issues-container').innerHTML = 
                            '<div class="loading"><div class="spinner"></div><div>Analyzing...</div></div>';
                    }
                    break;
                case 'scanResult':
                    enableButtons();
                    updateMetrics(message.data);
                    renderIssues(message.data.issues || []);
                    break;
                case 'fileAnalysis':
                    enableButtons();
                    updateMetrics(message.data);
                    renderIssues(message.data.issues || []);
                    break;
                case 'scanError':
                    enableButtons();
                    document.getElementById('issues-container').innerHTML = 
                        '<div class="error-state">Error: ' + message.error + '</div>';
                    break;
            }
        });
    </script>
</body>
</html>`;
	}

	public dispose() {
		this._disposables.forEach(d => d.dispose());
	}
}

// Types
interface SonarResult {
	bugs: number;
	vulnerabilities: number;
	codeSmells: number;
	coverage: number;
	issues: Array<{
		line: number;
		severity: string;
		category: string;
		message: string;
	}>;
}

interface FileAnalysis {
	bugs: number;
	warnings: number;
	issues: Array<{
		line: number;
		severity: string;
		category: string;
		message: string;
	}>;
	linesOfCode: number;
	commentLines: number;
	coverage: number;
	filePath: string;
	language: string;
}

interface FileIssue {
	line: number;
	severity: string;
	category: string;
	message: string;
}
