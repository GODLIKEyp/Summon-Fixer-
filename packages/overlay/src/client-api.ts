import type { TaskRequest, TaskState, EditApprovalResponse } from '@summon-fixer/contracts';

export type ApiErrorKind = 'timeout' | 'authorization' | 'validation' | 'connectivity' | 'execution';
export class SummonApiError extends Error {
  constructor(message: string, public readonly kind: ApiErrorKind, public readonly status = 0,
    public readonly code = 'ERR_NETWORK', public readonly details?: unknown) {
    super(message);
    this.name = 'SummonApiError';
  }
}
export interface ClientApiOptions { apiPrefix?: string; timeoutMs?: number }

export class SummonApiClient {
  private readonly apiPrefix: string;
  private readonly timeoutMs: number;
  private session: Promise<string> | null = null;

  constructor(options: ClientApiOptions = {}) {
    this.apiPrefix = options.apiPrefix ?? '/__summon/v1';
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  private async fetchJson(path: string, init: RequestInit): Promise<any> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.apiPrefix}${path}`, { ...init, credentials: 'same-origin', redirect: 'error', signal: controller.signal });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        const code = data?.error?.code ?? 'ERR_HTTP';
        const kind: ApiErrorKind = res.status === 401 || res.status === 403 ? 'authorization'
          : res.status === 408 || res.status === 504 || /TIMEOUT/.test(code) ? 'timeout'
          : res.status === 502 || res.status === 503 ? 'connectivity'
          : res.status < 500 ? 'validation' : 'execution';
        throw new SummonApiError(data?.error?.message ?? `Request failed (HTTP ${res.status}).`, kind, res.status, code, data?.error?.details);
      }
      if (!data) throw new SummonApiError('Bridge returned an invalid response.', 'execution', res.status, 'ERR_INVALID_RESPONSE');
      return data;
    } catch (err) {
      if (err instanceof SummonApiError) throw err;
      if (controller.signal.aborted) throw new SummonApiError('Request timed out. Its outcome is unknown; check the task before retrying.', 'timeout', 0, 'ERR_TIMEOUT');
      throw new SummonApiError('Unable to reach the local Summon bridge. Check the development server and connection.', 'connectivity');
    } finally { clearTimeout(timer); }
  }

  private async request(path: string, body?: unknown): Promise<any> {
    if (!this.session) {
      this.session = this.fetchJson('/session', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Summon-Bootstrap': '1' }, body: '{}',
      }).then(data => {
        if (typeof data.capability !== 'string' || !/^[a-f0-9]{64}$/.test(data.capability)) {
          throw new SummonApiError('Invalid browser session response.', 'authorization', 401, 'ERR_SESSION_UNAUTHORIZED');
        }
        return data.capability;
      }).catch(err => { this.session = null; throw err; });
    }
    const capability = await this.session;
    try {
      return await this.fetchJson(path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-Summon-Session': capability },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      // Never replay a mutation automatically. A reload can establish a new session.
      if (err instanceof SummonApiError && err.status === 401) this.session = null;
      throw err;
    }
  }

  async checkHealth(): Promise<{ status: string; bridge: string; engineConnected: boolean; message?: string }> {
    try { return await this.request('/health'); }
    catch (err) { return { status: 'error', bridge: 'unreachable', engineConnected: false, message: (err as Error).message }; }
  }
  async createTask(request: TaskRequest): Promise<{ taskId: string; state?: TaskState }> {
    const data = await this.request('/tasks', request);
    const state = data.state || data.task;
    return { taskId: data.taskId || state?.taskId, state };
  }
  async getTask(taskId: string): Promise<TaskState> {
    const data = await this.request(`/tasks/${encodeURIComponent(taskId)}`);
    return data.task || data;
  }
  async submitApproval(taskId: string, approval: EditApprovalResponse): Promise<{ success: boolean; state?: TaskState }> {
    const data = await this.request(`/tasks/${encodeURIComponent(taskId)}/approval`, approval);
    return { success: true, state: data.state || data.task };
  }
  async cancelTask(taskId: string, reason?: string): Promise<{ success: boolean }> {
    return this.request(`/tasks/${encodeURIComponent(taskId)}/cancel`, { reason });
  }
  async resolveSource(sourceId: string): Promise<{ sourceId: string; file: string; line: number; column: number; revision?: string } | null> {
    try { return await this.request(`/source/resolve?sourceId=${encodeURIComponent(sourceId)}`); }
    catch (err) { if (err instanceof SummonApiError && err.code === 'ERR_SOURCE_NOT_FOUND') return null; throw err; }
  }
}
