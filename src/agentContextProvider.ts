import * as vscode from 'vscode';
import * as os from 'os';
import { GatewayClient } from './gatewayClient';

export class AgentContextWebviewProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = 'agent-cockpit.agentContext';
	
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

		// Listen for messages from webview
		webviewView.webview.onDidReceiveMessage(async (message) => {
			switch (message.type) {
				case 'refresh':
					await this.refresh();
					break;
				case 'searchWiki':
					await this.searchWiki(message.query);
					break;
				case 'gatewayRequest':
					await this.handleGatewayRequest(message);
					break;
			}
		});
	}

	async refresh() {
		if (!this._view) return;
		
		const data = await this._collectAgentContextData();
		this._view.webview.postMessage({
			type: 'updateContext',
			data: data
		});
	}

	async searchWiki(query: string) {
		if (!this._view) return;
		
		try {
			const results = await this._gatewayClient.searchWiki(query);
			this._view.webview.postMessage({
				type: 'wikiResults',
				results: results
			});
		} catch (error) {
			this._view.webview.postMessage({
				type: 'wikiError',
				error: error instanceof Error ? error.message : String(error)
			});
		}
	}

	private async handleGatewayRequest(message: any) {
		try {
			const result = await this._gatewayClient.chat({
				prompt: message.prompt,
				skill: message.skill || '',
				context: message.context || ''
			});
			
			this._view?.webview.postMessage({
				type: 'gatewayResponse',
				response: result
			});
		} catch (error) {
			this._view?.webview.postMessage({
				type: 'gatewayError',
				error: error instanceof Error ? error.message : String(error)
			});
		}
	}

	async sendToGateway(payload: { prompt: string; skill: string; context: string }) {
		return await this._gatewayClient.chat(payload);
	}

	private async _collectAgentContextData() {
		const config = vscode.workspace.getConfiguration('agentCockpit');
		
		// Collect data in parallel
		const [prs, heartbeat, lessons] = await Promise.all([
			this._loadOpenPRs(config.get<string>('contributionsFile') || ''),
			this._loadHeartbeat(config.get<string>('heartbeatFile') || ''),
			this._loadLessons(config.get<string>('lessonsFile') || '')
		]);

		return {
			prs,
			heartbeat,
			lessons,
			timestamp: new Date().toISOString()
		};
	}

	private async _loadOpenPRs(contributionsPath: string): Promise<Array<{
		repo: string;
		pr: string;
		title: string;
		status: string;
	}>> {
		// First try to get from gateway (most up-to-date)
		try {
			const prs = await this._gatewayClient.getOpenPRs();
			if (prs && prs.length > 0) {
				return prs;
			}
		} catch {
			// Fall back to local file
		}

		// Fallback: parse contributions.md locally
		return await this._parseContributionsFile(contributionsPath);
	}

	private async _parseContributionsFile(path: string): Promise<Array<{
		repo: string;
		pr: string;
		title: string;
		status: string;
	}>> {
		try {
			const uri = vscode.Uri.file(path.replace(/^~\//, `${os.homedir()}/`));
			const content = await vscode.workspace.fs.readFile(uri);
			const text = new TextDecoder().decode(content);
			
			// Parse markdown table or list format
			const prs: Array<{repo: string; pr: string; title: string; status: string}> = [];
			const lines = text.split('\n');
			
			for (const line of lines) {
				// Match pattern: | repo | #pr | title | status |
				const match = line.match(/^\|\s*(.+?)\s*\|\s*(?:#|PR\s*)(\d+)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|$/);
				if (match) {
					prs.push({
						repo: match[1].trim(),
						pr: match[2],
						title: match[3].trim(),
						status: match[4].trim()
					});
				}
			}
			
			return prs;
		} catch {
			return [];
		}
	}

	private async _loadHeartbeat(heartbeatPath: string): Promise<{
		status: string;
		lastCheck: string;
		message?: string;
	}> {
		try {
			const status = await this._gatewayClient.getHeartbeat();
			if (status) {
				return status;
			}
		} catch {
			// Fall back to local file
		}

		// Fallback: parse heartbeat.md locally
		try {
			const uri = vscode.Uri.file(heartbeatPath.replace(/^~\//, `${os.homedir()}/`));
			const content = await vscode.workspace.fs.readFile(uri);
			const text = new TextDecoder().decode(content);
			
			// Parse simple format: "STATUS: ACTIVE | Last check: 2026-04-26T20:00:00Z"
			const statusMatch = text.match(/STATUS:\s*(\w+)/i);
			const timeMatch = text.match(/Last check:\s*(.+)/i);
			
			return {
				status: statusMatch ? statusMatch[1].toUpperCase() : 'UNKNOWN',
				lastCheck: timeMatch ? timeMatch[1].trim() : 'N/A',
				message: text.split('\n')[0]?.trim()
			};
		} catch {
			return {
				status: 'UNKNOWN',
				lastCheck: 'N/A'
			};
		}
	}

	private async _loadLessons(lessonsPath: string): Promise<Array<{
		date: string;
		lesson: string;
		mistake: string;
	}>> {
		try {
			// Try gateway first
			const lessons = await this._gatewayClient.getLessons();
			if (lessons && lessons.length > 0) {
				return lessons.slice(0, 3);
			}
		} catch {
			// Fall back to local file
		}

		// Fallback: parse mistakes.md locally
		try {
			const uri = vscode.Uri.file(lessonsPath.replace(/^~\//, `${os.homedir()}/`));
			const content = await vscode.workspace.fs.readFile(uri);
			const text = new TextDecoder().decode(content);
			
			const lessons: Array<{date: string; lesson: string; mistake: string}> = [];
			const lines = text.split('\n');
			
			let currentDate = '';
			let currentMistake = '';
			let currentLesson = '';
			
			for (const line of lines) {
				// Match date header: "## 2026-04-26" or "### 2026-04-26"
				const dateMatch = line.match(/^#{1,3}\s*(\d{4}-\d{2}-\d{2})/);
				if (dateMatch) {
					if (currentDate && currentLesson) {
						lessons.push({
							date: currentDate,
							mistake: currentMistake,
							lesson: currentLesson
						});
					}
					currentDate = dateMatch[1];
					currentMistake = '';
					currentLesson = '';
					continue;
				}
				
				// Match mistake: "- **Mistake:** ..."
				const mistakeMatch = line.match(/\*\*Mistake:\*\*\s*(.+)/);
				if (mistakeMatch) {
					currentMistake = mistakeMatch[1].trim();
					continue;
				}
				
				// Match lesson: "- **Lesson:** ..."
				const lessonMatch = line.match(/\*\*Lesson:\*\*\s*(.+)/);
				if (lessonMatch) {
					currentLesson = lessonMatch[1].trim();
					continue;
				}
			}
			
			// Don't forget the last entry
			if (currentDate && currentLesson) {
				lessons.push({
					date: currentDate,
					mistake: currentMistake,
					lesson: currentLesson
				});
			}
			
			return lessons.slice(0, 3);
		} catch {
			return [];
		}
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
        
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
            background-color: var(--bg-primary);
            color: var(--text-primary);
            font-size: 13px;
            line-height: 1.5;
            padding: 8px;
        }
        
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
            display: flex;
            justify-content: space-between;
            align-items: center;
            border-bottom: 1px solid var(--border-color);
        }
        
        .section-content {
            padding: 12px;
        }
        
        .status-badge {
            display: inline-block;
            padding: 2px 8px;
            border-radius: 12px;
            font-size: 11px;
            font-weight: 600;
            text-transform: uppercase;
        }
        
        .status-active {
            background-color: rgba(78, 201, 176, 0.2);
            color: var(--accent-green);
        }
        
        .status-inactive {
            background-color: rgba(244, 135, 113, 0.2);
            color: var(--accent-red);
        }
        
        .status-unknown {
            background-color: rgba(133, 133, 133, 0.2);
            color: var(--text-secondary);
        }
        
        .pr-item {
            padding: 8px 0;
            border-bottom: 1px solid var(--border-color);
        }
        
        .pr-item:last-child {
            border-bottom: none;
        }
        
        .pr-repo {
            font-weight: 600;
            color: var(--accent-blue);
        }
        
        .pr-title {
            margin-top: 2px;
            color: var(--text-primary);
        }
        
        .pr-meta {
            margin-top: 4px;
            font-size: 11px;
            color: var(--text-secondary);
        }
        
        .lesson-item {
            padding: 8px 0;
            border-bottom: 1px solid var(--border-color);
        }
        
        .lesson-item:last-child {
            border-bottom: none;
        }
        
        .lesson-date {
            font-size: 11px;
            color: var(--text-secondary);
        }
        
        .lesson-text {
            margin-top: 4px;
        }
        
        .lesson-mistake {
            color: var(--accent-red);
            font-style: italic;
        }
        
        .lesson-improvement {
            color: var(--accent-green);
            margin-top: 2px;
        }
        
        .search-box {
            width: 100%;
            padding: 6px 10px;
            background-color: var(--bg-tertiary);
            border: 1px solid var(--border-color);
            border-radius: 4px;
            color: var(--text-primary);
            font-size: 12px;
            margin-bottom: 8px;
        }
        
        .search-box:focus {
            outline: none;
            border-color: var(--accent-blue);
        }
        
        .search-results {
            max-height: 200px;
            overflow-y: auto;
        }
        
        .search-result-item {
            padding: 6px 0;
            border-bottom: 1px solid var(--border-color);
        }
        
        .search-result-title {
            font-weight: 600;
            color: var(--accent-blue);
        }
        
        .search-result-snippet {
            font-size: 11px;
            color: var(--text-secondary);
            margin-top: 2px;
        }
        
        .empty-state {
            text-align: center;
            padding: 16px;
            color: var(--text-secondary);
            font-style: italic;
        }
        
        .loading {
            text-align: center;
            padding: 16px;
            color: var(--text-secondary);
        }
        
        .heartbeat-info {
            display: flex;
            align-items: center;
            gap: 8px;
        }
        
        .heartbeat-time {
            font-size: 11px;
            color: var(--text-secondary);
        }
        
        .refresh-btn {
            background: none;
            border: none;
            color: var(--text-secondary);
            cursor: pointer;
            padding: 2px 6px;
            border-radius: 3px;
            font-size: 14px;
        }
        
        .refresh-btn:hover {
            background-color: var(--bg-tertiary);
            color: var(--text-primary);
        }
    </style>
</head>
<body>
    <!-- Agent Status Section -->
    <div class="section">
        <div class="section-header">
            <span>Agent Status</span>
            <button class="refresh-btn" onclick="refreshData()" title="Refresh">↻</button>
        </div>
        <div class="section-content">
            <div class="heartbeat-info">
                <span id="heartbeat-status" class="status-badge status-unknown">Loading...</span>
                <span id="heartbeat-time" class="heartbeat-time">Last check: --</span>
            </div>
        </div>
    </div>

    <!-- Open PRs Section -->
    <div class="section">
        <div class="section-header">
            <span>Open PRs</span>
            <span id="pr-count" style="color: var(--text-secondary); font-weight: normal;">0</span>
        </div>
        <div class="section-content" id="prs-container">
            <div class="loading">Loading PRs...</div>
        </div>
    </div>

    <!-- Lessons Learned Section -->
    <div class="section">
        <div class="section-header">
            <span>Lessons Learned</span>
            <span style="color: var(--text-secondary); font-weight: normal;">Last 3</span>
        </div>
        <div class="section-content" id="lessons-container">
            <div class="loading">Loading lessons...</div>
        </div>
    </div>

    <!-- Wiki Search Section -->
    <div class="section">
        <div class="section-header">
            <span>Wiki Search</span>
        </div>
        <div class="section-content">
            <input 
                type="text" 
                class="search-box" 
                id="wiki-search" 
                placeholder="Search wiki..."
                onkeyup="handleSearch(event)"
            >
            <div id="wiki-search-results" class="search-results"></div>
        </div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        
        // Listen for messages from extension
        window.addEventListener('message', event => {
            const message = event.data;
            switch (message.type) {
                case 'updateContext':
                    updateAgentContext(message.data);
                    break;
                case 'wikiResults':
                    displayWikiResults(message.results);
                    break;
                case 'wikiError':
                    document.getElementById('wiki-search-results').innerHTML = 
                        '<div class="search-result-item" style="color: var(--accent-red);">Error: ' + message.error + '</div>';
                    break;
            }
        });
        
        function refreshData() {
            vscode.postMessage({ type: 'refresh' });
        }
        
        function handleSearch(event) {
            if (event.key === 'Enter') {
                const query = document.getElementById('wiki-search').value.trim();
                if (query) {
                    vscode.postMessage({ type: 'searchWiki', query: query });
                }
            }
        }
        
        function updateAgentContext(data) {
            // Update heartbeat
            const heartbeatStatus = document.getElementById('heartbeat-status');
            const heartbeatTime = document.getElementById('heartbeat-time');
            
            heartbeatStatus.textContent = data.heartbeat.status;
            heartbeatStatus.className = 'status-badge ' + 
                (data.heartbeat.status === 'ACTIVE' ? 'status-active' : 
                 data.heartbeat.status === 'INACTIVE' ? 'status-inactive' : 'status-unknown');
            heartbeatTime.textContent = 'Last check: ' + data.heartbeat.lastCheck;
            
            // Update PRs
            const prsContainer = document.getElementById('prs-container');
            const prCount = document.getElementById('pr-count');
            prCount.textContent = data.prs.length;
            
            if (data.prs.length === 0) {
                prsContainer.innerHTML = '<div class="empty-state">No open PRs found</div>';
            } else {
                prsContainer.innerHTML = data.prs.map(pr => \`
                    <div class="pr-item">
                        <div class="pr-repo">\${pr.repo}</div>
                        <div class="pr-title">\${pr.title}</div>
                        <div class="pr-meta">PR #\${pr.pr} · \${pr.status}</div>
                    </div>
                \`).join('');
            }
            
            // Update lessons
            const lessonsContainer = document.getElementById('lessons-container');
            
            if (data.lessons.length === 0) {
                lessonsContainer.innerHTML = '<div class="empty-state">No lessons found</div>';
            } else {
                lessonsContainer.innerHTML = data.lessons.map(lesson => \`
                    <div class="lesson-item">
                        <div class="lesson-date">\${lesson.date}</div>
                        <div class="lesson-text lesson-mistake">\${lesson.mistake}</div>
                        <div class="lesson-text lesson-improvement">→ \${lesson.lesson}</div>
                    </div>
                \`).join('');
            }
        }
        
        function displayWikiResults(results) {
            const container = document.getElementById('wiki-search-results');
            if (!results || results.length === 0) {
                container.innerHTML = '<div class="search-result-item" style="color: var(--text-secondary);">No results found</div>';
                return;
            }
            
            container.innerHTML = results.map(result => \`
                <div class="search-result-item">
                    <div class="search-result-title">\${result.title}</div>
                    <div class="search-result-snippet">\${result.snippet}</div>
                </div>
            \`).join('');
        }
        
        // Initial load
        refreshData();
    </script>
</body>
</html>`;
	}

	public dispose() {
		this._disposables.forEach(d => d.dispose());
	}
}
