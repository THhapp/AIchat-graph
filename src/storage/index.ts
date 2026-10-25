/**
 * storage 公共入口：文件层与候选编辑。
 * changes 依赖 core 解析结果，但不读文件；commit 仍由调用方显式执行。
 */
export {
  StorageError,
  isErrnoCode,
  type StorageDiagnostic,
  type StorageErrorCode,
} from "./errors.js";
export { sha256Bytes, sha256File, isSha256Hex } from "./hash.js";
export {
  normalizeRelativePath,
  isWritableContentPath,
  resolveWorkspaceRoot,
  resolveWorkspacePath,
  resolveWritableContentPath,
  assertPathInsideWorkspace,
  ensureWorkspaceDirectory,
} from "./paths.js";
export {
  defaultAtomicWriter,
  writeFileDurable,
  writeFileCreateExclusive,
  syncDirectoryBestEffort,
  type AtomicWriteMode,
  type AtomicWriter,
} from "./atomic.js";
export {
  readWorkspaceFile,
  readWorkspaceFiles,
  parseWorkspaceInfo,
  decodeUtf8Strict,
  type LineEnding,
  type WorkspaceFile,
  type WorkspaceFiles,
  type WorkspaceInfo,
} from "./workspace.js";
export {
  initWorkspace,
  type InitWorkspaceOptions,
  type InitWorkspaceResult,
} from "./init.js";
export {
  TRANSACTIONS_DIR,
  commitFiles,
  completeTransaction,
  getTransaction,
  listTransactions,
  recoverTransactions,
  type CommitFileInput,
  type CommitFilesOptions,
  type CommitFilesResult,
  type CommittedFile,
  type RecoverTransactionsOptions,
  type RecoverTransactionsResult,
  type RecoveryAction,
  type TransactionFileRecord,
  type TransactionFileStatus,
  type TransactionJournal,
  type TransactionRecoveryReport,
  type TransactionState,
} from "./transactions.js";
export {
  ChangeError,
  flattenChangeRequestIssues,
  type ChangeErrorCode,
  type ChangeErrorOptions,
  type PreparedChanges,
  type FlatIssue,
} from "./changes/shared.js";
export {
  changeRequestSchema,
  prepareChanges,
  type ChangeRequest,
  type CreateTopicOperation,
  type CreateNodeOperation,
  type UpdateNodeOperation,
  type PatchNodeOperation,
  type UpdateConnectionOperation,
  type MoveNodeToTopicOperation,
  type RemoveLeafOperation,
  type SetDiscussionFocusOperation,
  type SetImportanceOperation,
  type ReplaceNodeSourceOperation,
  type Operation,
} from "./changes.js";
export {
  TOPIC_META_FILENAME,
  TOPICS_DIR,
  WORKSPACE_FILENAME,
  nodeFileName,
  nodePath,
  parseTopicPath,
  renderNodeFile,
  renderTopicMetaText,
  topicMetaPath,
  isTopicFilePath,
  type TopicPathParts,
} from "./format.js";
export {
  groupWorkspaceFiles,
  type GroupedWorkspaceFiles,
  type TopicGroup,
} from "./workspace.js";
