/**
 * storage 公共入口：文件层与候选编辑。
 * changes 依赖 core 解析结果，但不读文件；commit 仍由调用方显式执行。
 */
export {
  StorageError,
  diagnosticFromError,
  isErrnoCode,
  type StorageDiagnostic,
  type StorageErrorCode,
} from "./errors.js";
export { sha256Bytes, sha256File, isSha256Hex, normalizeSha256, EMPTY_SHA256 } from "./hash.js";
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
  findTopicFile,
  workspaceFilePath,
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
  changeRequestSchema,
  anyChangeRequestSchema,
  flattenChangeRequestIssues,
  prepareChanges,
  type ChangeErrorCode,
  type ChangeErrorOptions,
  type ChangeRequest,
  type CreateTopicOperation,
  type CreateNodeOperation,
  type UpdateNodeOperation,
  type InsertNextOperation,
  type InsertNextNodeInput,
  type MoveBranchOperation,
  type MoveNodeToTopicOperation,
  type ReplaceTopicOperation,
  type SetDiscussionFocusOperation,
  type RemoveLeafOperation,
  type MergeNodesOperation,
  type MergeReconnectEntry,
  type Operation,
  type PreparedChanges,
  prepareChangesForWorkspace,
  type AnyChangeRequest,
} from "./changes.js";
export {
  prepareChangesV2,
  v2ChangeRequestSchema,
  type V2ChangeRequest,
  type V2Operation,
  type V2CreateTopicOperation,
  type V2CreateNodeOperation,
  type V2UpdateNodeOperation,
  type V2MoveNodeToTopicOperation,
  type V2RemoveLeafOperation,
  type V2SetDiscussionFocusOperation,
  type V2SetImportanceOperation,
  type PatchNodeOperation,
  type UpdateConnectionOperation,
  type ReplaceNodeSourceOperation,
} from "./changes-v2.js";
export {
  planConversion,
  migrateWorkspace,
  type ConversionPlan,
  type ConvertedFile,
  type ConvertWorkspaceOptions,
  type MigrateWorkspaceOptions,
  type MigrateWorkspaceResult,
} from "./convert-v2.js";
export {
  TOPIC_META_FILENAME,
  TOPICS_DIR,
  WORKSPACE_FILENAME,
  DEFAULT_WORKSPACE_SCHEMA_VERSION,
  nodeFileName,
  nodePath,
  parseTopicPath,
  renderNodeFile,
  renderTopicMetaFile,
  topicMetaPath,
  isV2TopicFilePath,
  type TopicPathParts,
  type WorkspaceSchemaVersion,
} from "./format-v2.js";
export {
  groupWorkspaceFiles,
  expectedTopicMetaPath,
  type GroupedWorkspaceFiles,
  type TopicGroup,
} from "./workspace.js";
