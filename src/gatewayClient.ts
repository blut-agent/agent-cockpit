import * as vscode from 'vscode';
import * as https from 'https';
import * as http from 'http';
import * as url from 'url';

export interface GatewayRequest {
	prompt: string;
	skill?: string;
	context?: string;
}

export interface GatewayResponse {
	content: string;
	skill?: string;
}

export class GatewayClient {
	private baseUrl: string;
	private token: string | undefined;

	constructor() {
		const config = vscode.workspace.getConfiguration('agentCockpit');
		this.baseUrl = config.get<string>('gatewayUrl') || 'https://hermes.<domain>.com';
		
		// Try to get token from VS Code secrets
		this._loadToken();
	}

	private async _loadToken() {
		// VS Code secrets are per-workspace, not per-extension activation
		// We'll use a fallback approach
		try {
			// The token might be stored in VS Code settings or environment
			const envToken = process.env.HERMES_TOKEN;
			if (envToken) {
				this.token = envToken;
				return;
			}
		} catch {
			// Ignore errors during token loading
		}
	}

	async chat(request: GatewayRequest): Promise<string> {
		const token = this.token || '';
		
		const requestBody = JSON.stringify({
			prompt: request.prompt,
			skill: request.skill || '',
			context: request.context || ''
		});

		return new Promise((resolve, reject) => {
			const parsedUrl = new URL(this.baseUrl);
			const options: https.RequestOptions | http.RequestOptions = {
				hostname: parsedUrl.hostname,
				port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
				path: '/api/chat',
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Authorization': `Bearer ${token}`,
					'Content-Length': Buffer.byteLength(requestBody)
				}
			};

			const client = parsedUrl.protocol === 'https:' ? https : http;
			const req = client.request(options, (res) => {
				let data = '';
				
				// Check if streaming (SSE)
				const contentType = res.headers['content-type'] || '';
				
				if (contentType.includes('text/event-stream')) {
					// Handle SSE streaming
					res.on('data', (chunk) => {
						data += chunk.toString();
					});
					
					res.on('end', () => {
						try {
							// Parse SSE format: "data: {...}\n\n"
							const lines = data.split('\n');
							for (const line of lines) {
								if (line.startsWith('data: ')) {
									const jsonStr = line.slice(6);
									if (jsonStr.trim()) {
										const parsed = JSON.parse(jsonStr);
										if (parsed.content) {
											data = parsed.content;
										}
									}
								}
							}
							resolve(data);
						} catch (error) {
							reject(new Error(`Failed to parse SSE response: ${error}`));
						}
					});
				} else {
					// Regular JSON response
					res.on('data', (chunk) => {
						data += chunk.toString();
					});
					
					res.on('end', () => {
						try {
							const response = JSON.parse(data);
							resolve(response.content || response.response || data);
						} catch {
							resolve(data);
						}
					});
				}
			});

			req.on('error', (error) => {
				reject(new Error(`Gateway request failed: ${error.message}`));
			});

			req.setTimeout(30000, () => {
				req.destroy();
				reject(new Error('Gateway request timed out'));
			});

			req.write(requestBody);
			req.end();
		});
	}

	async getOpenPRs(): Promise<Array<{
		repo: string;
		pr: string;
		title: string;
		status: string;
	}>> {
		try {
			const response = await this.chat({
				prompt: 'List all my open PRs from contributions.md. Return as JSON array with fields: repo, pr, title, status.',
				skill: 'oss-contributor'
			});
			
			// Try to parse JSON from response
			const jsonMatch = response.match(/\[[\s\S]*\]/);
			if (jsonMatch) {
				return JSON.parse(jsonMatch[0]);
			}
		} catch {
			// Fall back to empty array
		}
		
		return [];
	}

	async getHeartbeat(): Promise<{
		status: string;
		lastCheck: string;
		message?: string;
	}> {
		try {
			const response = await this.chat({
				prompt: 'What is my current heartbeat status? Return as JSON with fields: status, lastCheck, message.',
				skill: 'wake-up'
			});
			
			const jsonMatch = response.match(/\{[\s\S]*\}/);
			if (jsonMatch) {
				return JSON.parse(jsonMatch[0]);
			}
		} catch {
			// Fall back to unknown
		}
		
		return {
			status: 'UNKNOWN',
			lastCheck: 'N/A'
		};
	}

	async getLessons(): Promise<Array<{
		date: string;
		lesson: string;
		mistake: string;
	}>> {
		try {
			const response = await this.chat({
				prompt: 'Return the last 3 lessons learned from mistakes.md. Return as JSON array with fields: date, lesson, mistake.',
				skill: 'systematic-debugging'
			});
			
			const jsonMatch = response.match(/\[[\s\S]*\]/);
			if (jsonMatch) {
				return JSON.parse(jsonMatch[0]);
			}
		} catch {
			// Fall back to empty array
		}
		
		return [];
	}

	async searchWiki(query: string): Promise<Array<{
		title: string;
		snippet: string;
		path?: string;
	}>> {
		try {
			const response = await this.chat({
				prompt: `Search the wiki for: "${query}". Return up to 5 results as JSON array with fields: title, snippet, path.`,
				skill: 'skill-graph'
			});
			
			const jsonMatch = response.match(/\[[\s\S]*\]/);
			if (jsonMatch) {
				return JSON.parse(jsonMatch[0]);
			}
		} catch {
			// Fall back to empty array
		}
		
		return [];
	}
}
