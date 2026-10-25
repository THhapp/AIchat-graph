// End-to-end offline check: build a real single-file HTML with D's renderer and
// the built reader assets, then assert it is self-contained. Not a production path.
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeContentFingerprint, renderTopicHtml, readReaderAssets } from '../../dist/export/index.js';

const reader = await readReaderAssets({ directory: 'dist/offline' });

const body = '第一段：按主题归档。\n\n- 列表一\n- 列表二\n\n| 列 | 值 |\n| --- | --- |\n| 甲 | 1 |\n\n行内公式 $a^2+b^2=c^2$。\n\n$$\n\\frac{1}{2} + \\frac{1}{3} = \\frac{5}{6}\n$$\n\n[外部链接](https://example.com) 与 [跨主题](记录的分寸.md)\n';

const nodes = [
  { id: 'n1', topicId: 't1', title: '根卡', summary: '摘要一', number: '01', from: null, flow: 'root', state: 'agreed', important: false, body, path: 'topics/a.md', fileHash: 'f1' },
  { id: 'n2', topicId: 't1', title: '纵向二', summary: '摘要二', number: '02', from: 'n1', flow: 'next', state: 'agreed', important: false, body: '正文二', path: 'topics/a.md', fileHash: 'f1', description: '为什么要接着讨论这条' },
  { id: 'n3', topicId: 't1', title: '右枝', summary: '摘要三', number: '01-01', from: 'n1', flow: 'branch', side: 'right', order: 10, state: 'proposed', important: false, body: '正文三', path: 'topics/a.md', fileHash: 'f1' },
  { id: 'n4', topicId: 't1', title: '左枝', summary: '摘要四', number: '01-02', from: 'n1', flow: 'branch', side: 'left', order: 20, state: 'reference', important: false, body: '正文四', path: 'topics/a.md', fileHash: 'f1' },
];

const document = {
  format: 1,
  workspaceId: 'w_demo',
  workspaceName: '离线校验',
  instanceId: 'inst_offline_demo',
  revision: 3,
  fingerprint: 'a'.repeat(64),
  generatedAt: '2026-10-22T01:00:00.000Z',
  topic: { id: 't1', title: '离线主题', path: 'topics/a.md', nodeIds: nodes.map((n) => n.id), fileHash: 'f1' },
  nodes,
  boundaryNodes: [],
  resources: {},
  resourceDiagnostics: [],
};

// The renderer requires the fingerprint to match the frozen content exactly.
document.fingerprint = computeContentFingerprint(document);
const html = renderTopicHtml({ document, readerScript: reader.script, readerStyles: reader.styles });
const dir = mkdtempSync(join(tmpdir(), 'aichat-offline-check-'));
const file = join(dir, 'topic.html');
writeFileSync(file, html, 'utf8');

const external = [...html.matchAll(/(?:src|href)\s*=\s*"(?!data:)([^"]+)"/g)].map((m) => m[1]);
const remoteRefs = external.filter((u) => /^(https?:)?\/\//i.test(u));
console.log(JSON.stringify({
  file,
  bytes: html.length,
  hasDataBlock: html.includes('id="aichat-export-data"'),
  hasRoot: html.includes('id="root"'),
  externalAttrs: external.slice(0, 5),
  remoteRefs,
  hasFetch: /\bfetch\s*\(/.test(reader.script),
  hasEventSource: /EventSource/.test(reader.script),
  readerFingerprint: reader.buildFingerprint.slice(0, 12),
  dir,
}, null, 1));