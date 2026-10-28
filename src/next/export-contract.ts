import type { TopicExportStatus } from './protocol.js';

export interface ExportManagerLike {
  init(): Promise<void>;
  statuses(): TopicExportStatus[];
  status(topicId: string): TopicExportStatus;
  bindTarget(topicId: string, targetPath: string | null): Promise<TopicExportStatus>;
  retry(topicId: string): Promise<TopicExportStatus>;
  schedule(topicIds: readonly string[]): void;
  close(): void;
}

export interface CreateExportManagerOptions {
  root: string;
  appRoot: string;
  offlineDirectory: string;
  workspaceId: string;
  workspaceName: string;
  /** Called whenever one topic export status changes; used for SSE. */
  onStatus?: (status: TopicExportStatus) => void;
}
