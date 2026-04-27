import * as vscode from 'vscode';
import * as os from 'os';
import { execSync } from 'child_process';
import { GatewayClient } from './gatewayClient';

export class CiStatusWebviewProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = 'agent-cockpit.ciStatus';
	
	private _view?: vscode.WebviewView;
	private _gatewayClient: GatewayClient;
	private _disposables: vscode.Disposable[] = [];
	private _currentRepo: string | null = null;

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
				case 'refresh':
					await this.refresh();
					break;
			}
		});

		// Auto-refresh when git repo changes
		vscode.workspace.onDidChangeWorkspaceFolders(() => {
			this._currentRepo = null;
			this.refresh();
		});
	}

	async refresh() {
		if (!this._view) return;
		
		const data = await this._collectCiStatusData();
		this._view.webview.postMessage({
			type: 'updateCiStatus',
			data: data
		});
	}

	private async _collectCiStatusData() {
		const repoInfo = this._getGitRepoInfo();
		
		if (!repoInfo) {
			return {
				repo: 'No git repo detected',
				commitStatus: null,
				openPrs: []
			};
		}

		this._currentRepo = repoInfo.remote;

		// Collect data in parallel
		const [commitStatus, openPrs] = await Promise.all([
			this._getCommitStatus(repoInfo),
			this._getOpenPRs(repoInfo)
		]);

		return {
			repo: repoInfo.remote,
			branch: repoInfo.branch,
			commit: repoInfo.commit,
			commitStatus,
			openPrs
		};
	}

	private _getGitRepoInfo() {
		try {
			const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
			if (!workspaceRoot) return null;

			const branch = execSync('git rev-parse --abbrev-ref HEAD', {
				cwd: workspaceRoot.fsPath,
				encoding: 'utf-8'
			}).trim();

			const commit = execSync('git log -1 --format=%h', {
				cwd: workspaceRoot.fsPath,
				encoding: 'utf-8'
			}).trim();

			const remote = execSync('git remote get-url origin', {
				cwd: workspaceRoot.fsPath,
				encoding: 'utf-8'
			}).trim()
			// Convert SSH/HTTPS URLs to owner/repo format
			.replace(/^git@github.com:/, '')
			.replace(/^https:\/\/github\.com\//, '')
			.replace(/\.git$/, '');

			const [owner, repo] = remote.split('/');
			if (!owner || !repo) return null;

			return { branch, commit, remote: `${owner}/${repo}` };
		} catch {
			return null;
		}
	}

	private async _getCommitStatus(repoInfo: { branch: string; commit: string; remote: string }) {
		try {
			// Try GitHub API first (if we have a token)
			const githubToken = process.env.GITHUB_TOKEN;
			if (githubToken) {
				const url = new URL(`https://api.github.com/repos/${repoInfo.remote}/commits/${repoInfo.commit}/check-runs`);
				
				const status = await this._fetchGitHubApi(url, githubToken);
				if (status) {
					const conclusions = status.check_runs?.map((run: any) => run.conclusion) || [];
					const statuses = status.statuses || [];
					
					return {
						status: status.status || 'pending',
						conclusions,
						statuses,
						source: 'github-api'
					};
				}
			}
		} catch {
			// Fall back to local
		}

		// Fallback: check for CI files locally
		return this._detectLocalCi(repoInfo);
	}

	private async _fetchGitHubApi(url: URL, token: string) {
		const { request } = await import('https');
		return new Promise<any>((resolve) => {
			const req = request(url, {
				headers: {
					'Authorization': `Bearer ${token}`,
					'Accept': 'application/vnd.github+json'
				}
			}, (res: any) => {
				let data = '';
				res.on('data', (chunk: any) => data += chunk);
				res.on('end', () => {
					try {
						resolve(JSON.parse(data));
					} catch {
						resolve(null);
					}
				});
			});
			req.on('error', () => resolve(null));
			req.end();
		});
	}

	private _detectLocalCi(repoInfo: { remote: string }) {
		try {
			const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
			if (!workspaceRoot) return null;

			const fs = require('fs');
			const path = require('path');
			const repoPath = workspaceRoot.fsPath;

			const ciFiles = [
				'.github/workflows',
				'.gitlab-ci.yml',
				'Jenkinsfile',
				'.circleci/config.yml',
				'.travis.yml'
			];

			const foundCi = ciFiles.filter(file => {
				const fullPath = path.join(repoPath, file);
				return fs.existsSync(fullPath);
			});

			return {
				status: 'unknown',
				ciSystem: foundCi.length > 0 ? foundCi[0].split('/')[1] : 'unknown',
				source: 'local-detection'
			};
		} catch {
			return null;
		}
	}

	private async _getOpenPRs(repoInfo: { remote: string; branch: string }) {
		try {
			// Try GitHub API
			const githubToken = process.env.GITHUB_TOKEN;
			if (githubToken) {
				const url = new URL(`https://api.github.com/repos/${repoInfo.remote}/pulls?state=open&sort=created&direction=desc`);
				
				const { request } = await import('https');
				const req = request(url, {
					headers: {
						'Authorization': `Bearer ${githubToken}`,
						'Accept': 'application/vnd.github+json'
					}
				}, (res) => {
					let data = '';
					res.on('data', (chunk) => data += chunk);
					res.on('end', () => {
						try {
							const prs = JSON.parse(data).map((pr: any) => ({
								number: pr.number,
								title: pr.title,
								author: pr.user?.login || 'unknown',
								status: pr.state,
								createdAt: pr.created_at,
								reviewStatus: this._estimateReviewStatus(pr)
							}));
							
							if (this._view) {
								this._view.webview.postMessage({
									type: 'updateOpenPrs',
									prs: prs
								});
							}
						} catch {
							// Ignore parse errors
						}
					});
				});
				req.on('error', () => {});
				req.end();
			}
		} catch {
			// Fall back to local
		}

		// Fallback: parse from local git
		return this._getLocalPRs(repoInfo);
	}

	private _estimateReviewStatus(pr: any) {
		const reviews = pr.reviews?.length || 0;
		const approved = pr.reviews?.filter((r: any) => r.state === 'APPROVED').length || 0;
		
		if (approved > 0) return 'Approved';
		if (reviews > 0) return 'Reviewed';
		if (pr.assignees?.length > 0) return 'Assigned';
		return 'Open';
	}

	private _getLocalPRs(repoInfo: { remote: string; branch: string }) {
		try {
			const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
			if (!workspaceRoot) return [];

			// Try to get PR info from local git
			const prs: Array<{
				number: string;
				title: string;
				author: string;
				status: string;
				createdAt: string;
				reviewStatus: string;
			}> = [];

			// Check for PR branches
			const branches = execSync('git branch -r --list origin/pr/*', {
				cwd: workspaceRoot.fsPath,
				encoding: 'utf-8'
			}).trim().split('\n').filter(Boolean);

			for (const branch of branches) {
				const match = branch.match(/origin\/pr\/(\d+)/);
				if (match) {
					prs.push({
						number: match[1],
						title: `PR #${match[1]}`,
						author: 'unknown',
						status: 'Open',
						createdAt: 'N/A',
						reviewStatus: 'Open'
					});
				}
			}

			return prs;
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
        
        * { margin: 0; padding: 0; box-sizing: border-box; }
        
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background-color: var(--bg-primary);
            color: var(--text-primary);
            font-size: 13px;
            line-height: 1.5;
            padding: 8px;
        }
        
        .repo-header {
            background-color: var(--bg-secondary);
            padding: 10px 12px;
            border: 1px solid var(--border-color);
            border-radius: 4px;
            margin-bottom: 16px;
        }
        
        .repo-name {
            font-weight: 600;
            color: var(--accent-blue);
            font-size: 14px;
        }
        
        .repo-meta {
            display: flex;
            gap: 12px;
            margin-top: 4px;
            font-size: 11px;
            color: var(--text-secondary);
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
        
        .ci-status {
            display: flex;
            align-items: center;
            gap: 8px;
        }
        
        .ci-badge {
            display: inline-block;
            padding: 2px 8px;
            border-radius: 12px;
            font-size: 11px;
            font-weight: 600;
            text-transform: uppercase;
        }
        
        .ci-success {
            background-color: rgba(78, 201, 176, 0.2);
            color: var(--accent-green);
        }
        
        .ci-failure {
            background-color: rgba(244, 135, 113, 0.2);
            color: var(--accent-red);
        }
        
        .ci-pending {
            background-color: rgba(220, 220, 170, 0.2);
            color: var(--accent-yellow);
        }
        
        .ci-unknown {
            background-color: rgba(133, 133, 133, 0.2);
            color: var(--text-secondary);
        }
        
        .ci-details {
            margin-top: 8px;
            font-size: 11px;
            color: var(--text-secondary);
        }
        
        .pr-item {
            padding: 8px 0;
            border-bottom: 1px solid var(--border-color);
        }
        
        .pr-item:last-child {
            border-bottom: none;
        }
        
        .pr-title {
            font-weight: 600;
            color: var(--text-primary);
        }
        
        .pr-meta {
            margin-top: 4px;
            font-size: 11px;
            color: var(--text-secondary);
            display: flex;
            gap: 8px;
        }
        
        .pr-review-status {
            padding: 1px 6px;
            border-radius: 10px;
            font-size: 10px;
            font-weight: 600;
        }
        
        .pr-review-approved {
            background-color: rgba(78, 201, 176, 0.2);
            color: var(--accent-green);
        }
        
        .pr-review-reviewed {
            background-color: rgba(220, 220, 170, 0.2);
            color: var(--accent-yellow);
        }
        
        .pr-review-open {
            background-color: rgba(133, 133, 133, 0.2);
            color: var(--text-secondary);
        }
        
        .empty-state {
            text-align: center;
            padding: 24px;
            color: var(--text-secondary);
            font-style: italic;
        }
        
        .loading {
            text-align: center;
            padding: 16px;
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
    <!-- Repo Header -->
    <div class="repo-header" id="repo-header">
        <div class="repo-name">Loading repo...</div>
        <div class="repo-meta">
            <span id="repo-branch">Branch: --</span>
            <span id="repo-commit">Commit: --</span>
        </div>
    </div>

    <!-- CI Status Section -->
    <div class="section">
        <div class="section-header">
            <span>CI Status</span>
            <button class="refresh-btn" onclick="refreshData()" title="Refresh">↻</button>
        </div>
        <div class="section-content" id="ci-status-container">
            <div class="loading">Checking CI status...</div>
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

    <script>
        const vscode = acquireVsCodeApi();
        
        window.addEventListener('message', event => {
            const message = event.data;
            switch (message.type) {
                case 'updateCiStatus':
                    updateCiStatus(message.data);
                    break;
                case 'updateOpenPrs':
                    updateOpenPrs(message.prs);
                    break;
            }
        });
        
        function refreshData() {
            vscode.postMessage({ type: 'refresh' });
        }
        
        function updateCiStatus(data) {
            // Update repo header
            document.querySelector('.repo-name').textContent = data.repo;
            document.getElementById('repo-branch').textContent = 'Branch: ' + (data.branch || '--');
            document.getElementById('repo-commit').textContent = 'Commit: ' + (data.commit || '--');
            
            // Update CI status
            const ciContainer = document.getElementById('ci-status-container');
            
            if (!data.commitStatus) {
                ciContainer.innerHTML = '<div class="empty-state">No CI status available</div>';
                return;
            }
            
            const statusClass = data.commitStatus.status === 'success' ? 'ci-success' :
                              data.commitStatus.status === 'failure' ? 'ci-failure' :
                              data.commitStatus.status === 'pending' ? 'ci-pending' : 'ci-unknown';
            
            let html = '<div class="ci-status">';
            html += '<span class="ci-badge ' + statusClass + '">' + data.commitStatus.status + '</span>';
            html += '</div>';
            
            if (data.commitStatus.ciSystem) {
                html += '<div class="ci-details">CI System: ' + data.commitStatus.ciSystem + '</div>';
            }
            
            if (data.commitStatus.conclusions && data.commitStatus.conclusions.length > 0) {
                html += '<div class="ci-details">Checks: ' + data.commitStatus.conclusions.join(', ') + '</div>';
            }
            
            ciContainer.innerHTML = html;
        }
        
        function updateOpenPrs(prs) {
            const container = document.getElementById('prs-container');
            const count = document.getElementById('pr-count');
            count.textContent = prs.length;
            
            if (prs.length === 0) {
                container.innerHTML = '<div class="empty-state">No open PRs found</div>';
                return;
            }
            
            container.innerHTML = prs.map(pr => {
                const reviewClass = pr.reviewStatus === 'Approved' ? 'pr-review-approved' :
                                  pr.reviewStatus === 'Reviewed' ? 'pr-review-reviewed' : 'pr-review-open';
                
                return '<div class="pr-item">' +
                    '<div class="pr-title">PR #' + pr.number + ': ' + pr.title + '</div>' +
                    '<div class="pr-meta">' +
                        '<span>by ' + pr.author + '</span>' +
                        '<span class="pr-review-status ' + reviewClass + '">' + pr.reviewStatus + '</span>' +
                    '</div>' +
                '</div>';
            }).join('');
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
