/**
 * export 公共入口：资源捕获与安全单 HTML 封装。
 * 读者、Markdown 渲染与布局不在此实现；service 负责调用、授权与写盘。
 */
export {
  captureResources,
  resolveResourcePath,
} from './capture.js';
export {
  renderTopicHtml,
  computeContentFingerprint,
  computeExportFingerprints,
  readExportMarkers,
  escapeHtml,
  escapeJsonForHtml,
  stableStringify,
} from './render.js';
export {
  readReaderAssets,
  assertSelfContainedStyles,
} from './readerAssets.js';
export { ExportError } from './errors.js';
export {
  EXPORT_FORMAT_VERSION,
  EXPORT_DATA_ELEMENT_ID,
  DEFAULT_MAX_RESOURCE_BYTES,
  DEFAULT_MAX_TOTAL_RESOURCE_BYTES,
  type CaptureResourcesOptions,
  type CapturedDataImage,
  type CapturedResourceFile,
  type ExportDocumentLike,
  type ExportErrorCode,
  type ExportFingerprints,
  type ExportMarkers,
  type ExportResourceNode,
  type ReadReaderAssetsOptions,
  type ReaderAssets,
  type RenderTopicHtmlInput,
  type ResourceCapture,
  type ResourceReference,
} from './types.js';