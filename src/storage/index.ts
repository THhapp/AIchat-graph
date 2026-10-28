/** Minimal filesystem helpers kept for the SQLite runtime, exporter and one-time importer. */
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
