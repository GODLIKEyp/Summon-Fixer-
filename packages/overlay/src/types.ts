import type {
  TaskRequest,
  TaskState,
  TaskStatus,
  EditApprovalResponse,
  TaskContext,
  FileContext,
  UIContext,
  SourceSelection,
  PermissionMode,
} from '@summon-fixer/contracts';

export type {
  TaskRequest,
  TaskState,
  TaskStatus,
  EditApprovalResponse,
  TaskContext,
  FileContext,
  UIContext,
  SourceSelection,
  PermissionMode,
};

export interface SelectedElementContext {
  element: Element;
  tagName: string;
  textContent: string;
  accessibleLabel?: string;
  role?: string;
  elementSelector: string;
  attributes: Record<string, string>;
  surroundingContext: string;
  sourceId?: string;
  sourceRevision?: string;
  sourceLocation?: {
    file: string;
    line: number;
    column: number;
  };
}

export interface OverlayConfig {
  apiPrefix?: string;
  shortcut?: string;
  shortcutFallback?: string;
  theme?: 'dark' | 'light' | 'auto';
  defaultMode?: PermissionMode;
}

export interface OverlayState {
  pointModeActive: boolean;
  selectedElement: SelectedElementContext | null;
  panelOpen: boolean;
  promptText: string;
  permissionMode: PermissionMode;
  currentTaskId: string | null;
  currentTaskState: TaskState | null;
  isSubmitting: boolean;
  isPolling: boolean;
  engineConnected: boolean;
  connectionError: string | null;
}
