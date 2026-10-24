import type {
  TaskRequest,
  TaskState,
  EditApprovalResponse,
} from '@summon-fixer/contracts';

export interface ClientApiOptions {
  apiPrefix?: string;
}

export class SummonApiClient {
  private apiPrefix: string;

  constructor(options: ClientApiOptions = {}) {
    this.apiPrefix = options.apiPrefix ?? '/__summon/v1';
  }

  /**
   * Health check to verify dev server bridge and loopback engine connectivity.
   */
  async checkHealth(): Promise<{ status: string; bridge: string; engineConnected: boolean; message?: string }> {
    try {
      const res = await fetch(`${this.apiPrefix}/health`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) {
        return {
          status: 'error',
          bridge: 'reachable',
          engineConnected: false,
          message: `Server returned HTTP ${res.status}`,
        };
      }
      return await res.json();
    } catch (err) {
      return {
        status: 'error',
        bridge: 'unreachable',
        engineConnected: false,
        message: err instanceof Error ? err.message : 'Network request failed',
      };
    }
  }

  /**
   * Submits an untrusted TaskRequest to the Summon Fixer engine.
   */
  async createTask(request: TaskRequest): Promise<{ taskId: string; state?: TaskState }> {
    let res: Response;
    try {
      res = await fetch(`${this.apiPrefix}/tasks`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(request),
      });
    } catch (err) {
      throw new Error(
        `Failed to reach Summon Fixer bridge: ${err instanceof Error ? err.message : 'Network error'}`
      );
    }

    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      const msg = errBody?.error?.message || errBody?.message || `HTTP ${res.status} ${res.statusText}`;
      throw new Error(`Engine request failed: ${msg}`);
    }

    const data = await res.json();
    const task = data.task || data.state || data;
    return {
      taskId: data.taskId || task.taskId,
      state: data.state || data.task,
    };
  }

  /**
   * Polls the authoritative task state from the engine.
   */
  async getTask(taskId: string): Promise<TaskState> {
    let res: Response;
    try {
      res = await fetch(`${this.apiPrefix}/tasks/${encodeURIComponent(taskId)}`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
      });
    } catch (err) {
      throw new Error(
        `Failed to connect to Summon Fixer bridge: ${err instanceof Error ? err.message : 'Network error'}`
      );
    }

    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      const msg = errBody?.error?.message || errBody?.message || `HTTP ${res.status} ${res.statusText}`;
      throw new Error(`Failed to fetch task: ${msg}`);
    }

    const data = await res.json();
    return data.task || data;
  }

  /**
   * Submits a user approval or rejection for proposed file edits.
   */
  async submitApproval(taskId: string, approval: EditApprovalResponse): Promise<{ success: boolean; state?: TaskState }> {
    let res: Response;
    try {
      res = await fetch(`${this.apiPrefix}/tasks/${encodeURIComponent(taskId)}/approval`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(approval),
      });
    } catch (err) {
      throw new Error(
        `Failed to reach bridge for approval: ${err instanceof Error ? err.message : 'Network error'}`
      );
    }

    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      const msg = errBody?.error?.message || errBody?.message || `HTTP ${res.status} ${res.statusText}`;
      throw new Error(`Approval submission failed: ${msg}`);
    }

    const data = await res.json();
    return {
      success: true,
      state: data.state || data.task,
    };
  }

  /**
   * Requests cancellation of an in-flight task.
   */
  async cancelTask(taskId: string, reason?: string): Promise<{ success: boolean }> {
    let res: Response;
    try {
      res = await fetch(`${this.apiPrefix}/tasks/${encodeURIComponent(taskId)}/cancel`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ reason: reason || 'Cancelled by user from overlay' }),
      });
    } catch (err) {
      throw new Error(
        `Failed to reach bridge for cancellation: ${err instanceof Error ? err.message : 'Network error'}`
      );
    }

    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      const msg = errBody?.error?.message || errBody?.message || `HTTP ${res.status}`;
      throw new Error(`Task cancellation failed: ${msg}`);
    }

    return await res.json();
  }

  /**
   * Resolves a server-side verified source location for a sourceId.
   */
  async resolveSource(sourceId: string): Promise<{
    sourceId: string;
    file: string;
    line: number;
    column: number;
    revision?: string;
  } | null> {
    try {
      const res = await fetch(`${this.apiPrefix}/source/resolve?sourceId=${encodeURIComponent(sourceId)}`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }
}
