import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Diagnostic, GraphNode, OfflineTopicDocument } from '../../src/shared/protocol.js';
import {
  captureResources,
  computeContentFingerprint,
  computeExportFingerprints,
  EXPORT_DATA_ELEMENT_ID,
  ExportError,
  readExportMarkers,
  readReaderAssets,
  renderTopicHtml,
  resolveResourcePath,
  assertSelfContainedStyles,
  type ExportResourceNode,
} from '../../src/export/index.js';

const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const GIF_HEAD = Buffer.from('GIF89a', 'ascii');
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function newRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aichat-export-'));
  roots.push(root);
  return root;
}

async function writeFile(root: string, relative: string, bytes: Buffer | string): Promise<void> {
  const absolute = path.join(root, ...relative.split('/'));
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, bytes);
}

function graphNode(id: string, title: string): GraphNode {
  return {
    id,
    topicId: 't1',
    title,
    summary: '',
    number: '01',
    from: null,
    flow: 'root',
    state: 'agreed',
    important: false,
  };
}

function document(overrides: Partial<OfflineTopicDocument> = {}): OfflineTopicDocument {
  const body = '正文第一段\u2028第二段 </script><script>alert(1)</script> & 结束';
  const base: OfflineTopicDocument = {
    format: 1,
    workspaceId: 'ws-1',
    workspaceName: '测试工作区',
    instanceId: 'inst-1',
    revision: 7,
    fingerprint: 'placeholder',
    generatedAt: '2026-01-01T00:00:00.000Z',
    topic: { id: 't1', title: '主题 </title><script>x</script>', path: 'topics/t.md', nodeIds: ['n1'], fileHash: 'a'.repeat(64) },
    nodes: [{ ...graphNode('n1', '节点一'), body, path: 'topics/t.md', fileHash: 'b'.repeat(64) }],
    boundaryNodes: [],
    resources: {},
    resourceDiagnostics: [],
  };
  const merged: OfflineTopicDocument = { ...base, ...overrides };
  return { ...merged, fingerprint: computeContentFingerprint(merged) };
}

const READER_SCRIPT = '(()=>{const e=document.getElementById("root");if(e)e.textContent="reader";})();';
const READER_STYLES = 'body{margin:0}.bg{background:url("data:image/png;base64,AAAA")}';

function resourceNode(body: string, topicPath = 'topics/t.md', id = 'n1'): ExportResourceNode {
  return { id, path: topicPath, body };
}

describe('renderTopicHtml', () => {
  it('embeds the complete frozen document in a non-executable JSON block', () => {
    const doc = document({
      nodes: [1, 2, 3].map((index) => ({
        ...graphNode('n' + String(index), '节点' + String(index)),
        body: '正文' + String(index),
        path: 'topics/t.md',
        fileHash: 'c'.repeat(64),
      })),
      boundaryNodes: [graphNode('ext', '跨主题来源')],
      resources: { 'resources/a.png': 'data:image/png;base64,' + PNG_HEAD.toString('base64') },
      resourceDiagnostics: [],
    });
    const html = renderTopicHtml({ document: doc, readerScript: READER_SCRIPT, readerStyles: READER_STYLES });

    const start = html.indexOf('<script id="' + EXPORT_DATA_ELEMENT_ID + '" type="application/json">');
    expect(start).toBeGreaterThan(-1);
    const jsonStart = html.indexOf('>', start) + 1;
    const jsonEnd = html.indexOf('</script>', jsonStart);
    const embedded = html.slice(jsonStart, jsonEnd);
    const parsed = JSON.parse(embedded) as OfflineTopicDocument;

    // 不按折叠/过滤删减：节点、边界来源、资源、诊断全部原样保留。
    expect(parsed.nodes).toHaveLength(3);
    expect(parsed.boundaryNodes).toHaveLength(1);
    expect(parsed.resources['resources/a.png']).toBe(doc.resources['resources/a.png']);
    expect(parsed.revision).toBe(7);
    expect(parsed.fingerprint).toBe(computeContentFingerprint(doc));
    expect(parsed.nodes[0]?.body).toBe('正文1');
  });

  it('escapes dangerous body text and only loads a trusted built reader', () => {
    const doc = document();
    const html = renderTopicHtml({ document: doc, readerScript: READER_SCRIPT, readerStyles: READER_STYLES });

    // 正文里的脚本终止串被转义，不能提前关闭数据块。
    expect(html).not.toContain('</script><script>alert(1)');
    expect(html).toContain('\\u003c/script\\u003e');
    expect(html).not.toContain('\u2028');
    expect(html).toContain('\\u2028');

    // 只有两个 script：JSON 数据块与 base64 data: URI 的可信读者；正文不在可执行脚本中。
    const scripts = html.match(/<script/g) ?? [];
    expect(scripts).toHaveLength(2);
    expect(html).toMatch(/<script src="data:text\/javascript;base64,[A-Za-z0-9+/=]+"><\/script>/);
    expect(html).not.toContain('alert(1)</script>');

    // 标题被转义，不会破坏 head。
    expect(html).toContain('&lt;/title&gt;');
  });

  it('rejects documents whose resource values are not supported data images', () => {
    const bad = document({ resources: { 'resources/a.png': 'https://example.com/a.png' } });
    expect(() => renderTopicHtml({ document: bad, readerScript: READER_SCRIPT, readerStyles: READER_STYLES })).toThrow(ExportError);
    const traversal = document({ resources: { '../outside.png': 'data:image/png;base64,AAAA' } });
    expect(() => renderTopicHtml({ document: traversal, readerScript: READER_SCRIPT, readerStyles: READER_STYLES })).toThrow(/安全/);
    expect(() => renderTopicHtml({ document: document({ format: 2 as 1 }), readerScript: READER_SCRIPT, readerStyles: READER_STYLES })).toThrow(/format/);
  });

  it('writes readable export markers tied to content and reader build', () => {
    const doc = document();
    const first = renderTopicHtml({ document: doc, readerScript: READER_SCRIPT, readerStyles: READER_STYLES });
    const markers = readExportMarkers(first);
    expect(markers).not.toBeNull();
    expect(markers?.workspaceId).toBe('ws-1');
    expect(markers?.topicId).toBe('t1');
    expect(markers?.format).toBe(1);
    expect(markers?.contentFingerprint).toBe(computeContentFingerprint(doc));

    const fingerprints = computeExportFingerprints({ document: doc, readerScript: READER_SCRIPT, readerStyles: READER_STYLES });
    expect(markers?.readerFingerprint).toBe(fingerprints.readerFingerprint);
    expect(markers?.exportFingerprint).toBe(fingerprints.exportFingerprint);

    const otherReader = renderTopicHtml({ document: doc, readerScript: READER_SCRIPT + ';', readerStyles: READER_STYLES });
    expect(readExportMarkers(otherReader)?.exportFingerprint).not.toBe(fingerprints.exportFingerprint);
    expect(readExportMarkers('<html><head></head></html>')).toBeNull();
  });
});

describe('content fingerprint', () => {
  it('ignores runtime fields and survives restarts/unrelated publishes', () => {
    const base = document();
    const fingerprint = computeContentFingerprint(base);
    expect(base.fingerprint).toBe(fingerprint);

    const restarted = document({ instanceId: 'inst-2', revision: 99, generatedAt: '2030-05-05T00:00:00.000Z' });
    expect(computeContentFingerprint(restarted)).toBe(fingerprint);

    const otherTopicOnly = { ...restarted, fingerprint: 'stale-value-ignored' };
    expect(computeContentFingerprint(otherTopicOnly)).toBe(fingerprint);

    const changedBody = document({
      nodes: [{ ...graphNode('n1', '节点一'), body: '改过的正文', path: 'topics/t.md', fileHash: 'b'.repeat(64) }],
    });
    expect(computeContentFingerprint(changedBody)).not.toBe(fingerprint);

    // 键顺序不同不应改变指纹。
    const reordered = Object.fromEntries(
      Object.entries(document()).reverse(),
    ) as unknown as OfflineTopicDocument;
    expect(computeContentFingerprint({ ...reordered, fingerprint: fingerprint })).toBe(fingerprint);
  });

  it('refuses to render when document.fingerprint disagrees with content', () => {
    const doc = document();
    const tampered: OfflineTopicDocument = { ...doc, fingerprint: 'some-other-hash' };
    expect(() => renderTopicHtml({ document: tampered, readerScript: READER_SCRIPT, readerStyles: READER_STYLES })).toThrow(/内容指纹/);
    expect(() => computeExportFingerprints({ document: tampered, readerScript: READER_SCRIPT, readerStyles: READER_STYLES })).toThrow(ExportError);
  });

  it('separates reader upgrade from content fingerprint', () => {
    const doc = document();
    const a = computeExportFingerprints({ document: doc, readerScript: READER_SCRIPT, readerStyles: READER_STYLES });
    const b = computeExportFingerprints({ document: doc, readerScript: READER_SCRIPT + ';/*v2*/', readerStyles: READER_STYLES });
    expect(b.contentFingerprint).toBe(a.contentFingerprint);
    expect(b.readerFingerprint).not.toBe(a.readerFingerprint);
    expect(b.exportFingerprint).not.toBe(a.exportFingerprint);
  });
});

describe('captureResources', () => {
  it('captures only referenced images inside resources/ and reports byte facts', async () => {
    const root = await newRoot();
    await writeFile(root, 'resources/a.png', PNG_HEAD);
    await writeFile(root, 'resources/sub/b.gif', GIF_HEAD);
    await writeFile(root, 'resources/unused.png', PNG_HEAD);

    const capture = await captureResources(root, [
      resourceNode('文本 ![图一](resources/a.png "标题")'),
      resourceNode('再有 ![图二](./resources/sub/b.gif)', 'topics/nested/deep.md'),
      resourceNode('代码里的不算: `![x](resources/a.png)`'),
    ]);

    expect(capture.ok).toBe(true);
    expect(capture.diagnostics).toEqual([]);
    expect(Object.keys(capture.resources).sort()).toEqual(['resources/a.png', 'resources/sub/b.gif']);
    expect(capture.resources['resources/a.png']).toBe('data:image/png;base64,' + PNG_HEAD.toString('base64'));
    expect(capture.files.map((file) => file.path)).toEqual(['resources/a.png', 'resources/sub/b.gif']);
    expect(capture.files[0]?.sha256).toHaveLength(64);
    expect(capture.totalBytes).toBe(PNG_HEAD.byteLength + GIF_HEAD.byteLength);
    // 未引用的附件不被收集。
    expect(capture.resources['resources/unused.png']).toBeUndefined();
  });

  it('reports missing, unsupported, mismatched and oversized resources instead of omitting them', async () => {
    const root = await newRoot();
    await writeFile(root, 'resources/real.png', PNG_HEAD);
    await writeFile(root, 'resources/wrong.png', GIF_HEAD);
    await writeFile(root, 'resources/vector.svg', '<svg/>');
    await writeFile(root, 'resources/big.png', Buffer.concat([PNG_HEAD, Buffer.alloc(2048)]));

    const missing = await captureResources(root, [resourceNode('![m](resources/missing.png)')]);
    expect(missing.ok).toBe(false);
    expect(codes(missing.diagnostics)).toContain('RESOURCE_MISSING');
    expect(Object.keys(missing.resources)).toHaveLength(0);

    const unsupported = await captureResources(root, [resourceNode('![s](resources/vector.svg)')]);
    expect(unsupported.ok).toBe(false);
    expect(codes(unsupported.diagnostics)).toContain('RESOURCE_UNSUPPORTED');

    const mismatch = await captureResources(root, [resourceNode('![w](resources/wrong.png)')]);
    expect(mismatch.ok).toBe(false);
    expect(codes(mismatch.diagnostics)).toContain('RESOURCE_TYPE_MISMATCH');

    const oversized = await captureResources(root, [resourceNode('![b](resources/big.png)')], { maxFileBytes: 1024 });
    expect(oversized.ok).toBe(false);
    expect(codes(oversized.diagnostics)).toContain('RESOURCE_TOO_LARGE');

    const outside = await captureResources(root, [resourceNode('![o](../outside.png)')]);
    expect(outside.ok).toBe(false);
    expect(outside.resources).toEqual({});
  });

  it('accepts safe inline data images and rejects unsafe schemes or fake types', async () => {
    const root = await newRoot();
    const uri = 'data:image/png;base64,' + PNG_HEAD.toString('base64');
    const capture = await captureResources(root, [
      resourceNode('内联 ![i](' + uri + ') 再来一次 ![i2](' + uri + ')'),
    ]);
    expect(capture.ok).toBe(true);
    expect(capture.dataImages).toHaveLength(1);
    expect(capture.dataImages[0]?.count).toBe(2);
    expect(capture.references.every((reference) => reference.kind === 'data')).toBe(true);

    const fake = await captureResources(root, [resourceNode('![f](data:image/png;base64,' + GIF_HEAD.toString('base64') + ')')]);
    expect(fake.ok).toBe(false);
    expect(codes(fake.diagnostics)).toContain('RESOURCE_TYPE_MISMATCH');

    const remote = await captureResources(root, [resourceNode('![r](https://example.com/a.png)')]);
    expect(remote.ok).toBe(false);
    expect(codes(remote.diagnostics)).toContain('RESOURCE_UNSUPPORTED');

    const scriptScheme = await captureResources(root, [resourceNode('![j](javascript:alert(1))')]);
    expect(scriptScheme.ok).toBe(false);
  });

  it('keeps every diagnostic within the shared Diagnostic shape', async () => {
    const root = await newRoot();
    const capture = await captureResources(root, [
      resourceNode('![m](resources/missing-for-shape.png)'),
      resourceNode('![u](https://example.com/a.png)'),
    ]);
    expect(capture.ok).toBe(false);
    // 共享 Diagnostic 只有既有字段；引用原文不得作为额外属性泄漏。
    for (const diagnostic of capture.diagnostics) {
      const keys = Object.keys(diagnostic).sort();
      expect(keys.every((key) => ['code', 'message', 'severity', 'path', 'topicId', 'nodeId', 'line', 'column', 'offset', 'endOffset'].includes(key))).toBe(true);
      expect(diagnostic.message.length).toBeGreaterThan(0);
    }
    const missing = capture.diagnostics.find((diagnostic) => diagnostic.code === 'RESOURCE_MISSING');
    expect(missing?.message).toContain('resources/missing-for-shape.png');
    expect(missing?.path).toBe('resources/missing-for-shape.png');
    const remote = capture.diagnostics.find((diagnostic) => diagnostic.code === 'RESOURCE_UNSUPPORTED');
    expect(remote?.message).toContain('https://example.com/a.png');
  });

  it('refuses symlinked or junction resource paths when the host allows creating them', async () => {
    const root = await newRoot();
    const outside = await newRoot();
    await writeFile(outside, 'secret.png', PNG_HEAD);
    const linkPath = path.join(root, 'resources', 'link.png');
    await fs.mkdir(path.dirname(linkPath), { recursive: true });
    try {
      await fs.symlink(path.join(outside, 'secret.png'), linkPath);
    } catch {
      return; // 无符号链接权限的主机跳过；其余用例仍覆盖 realpath 约束。
    }
    const capture = await captureResources(root, [resourceNode('![l](resources/link.png)')]);
    expect(capture.ok).toBe(false);
    expect(codes(capture.diagnostics)).toEqual(expect.arrayContaining(['RESOURCE_UNSAFE']));
    expect(capture.resources).toEqual({});
  });

  it('rejects unsafe roots and invalid options concretely', async () => {
    await expect(captureResources(path.join(os.tmpdir(), 'definitely-missing-aichat-root'), [])).rejects.toMatchObject({ code: 'WORKSPACE_ROOT_INVALID' });
    const root = await newRoot();
    await expect(captureResources(root, [], { maxFileBytes: 0 })).rejects.toMatchObject({ code: 'EXPORT_DOCUMENT_INVALID' });
  });

  it('passes through the snapshot identity for stale-write checks', async () => {
    const root = await newRoot();
    const capture = await captureResources(root, [], { snapshot: { instanceId: 'inst-1', revision: 4 } });
    expect(capture.snapshot).toEqual({ instanceId: 'inst-1', revision: 4 });
    expect(capture.ok).toBe(true);
  });
});

describe('reference images and normal filenames', () => {
  it('captures ![x][ref] / collapsed / shortcut images through the same restricted pipeline', async () => {
    const root = await newRoot();
    await writeFile(root, 'resources/ref-full.png', PNG_HEAD);
    await writeFile(root, 'resources/ref-collapsed.gif', GIF_HEAD);
    await writeFile(root, 'resources/shortcut.png', PNG_HEAD);

    const body = [
      '全写 ![x][full]',
      '',
      '[full]: resources/ref-full.png',
      '',
      '折叠 ![collapsed][]',
      '',
      '[collapsed]: ./resources/ref-collapsed.gif',
      '',
      '简写 ![shortcut]',
      '',
      '[shortcut]: <resources/shortcut.png> "标题"',
    ].join('\n');

    const capture = await captureResources(root, [resourceNode(body)]);
    expect(capture.ok).toBe(true);
    expect(capture.diagnostics).toEqual([]);
    expect(Object.keys(capture.resources).sort()).toEqual([
      'resources/ref-collapsed.gif',
      'resources/ref-full.png',
      'resources/shortcut.png',
    ]);
  });

  it('treats an undefined reference as plain text, not as a resource', async () => {
    const root = await newRoot();
    const body = '教材示例：写法 ![x][missing-def] 在标准 Markdown 中只是普通文字。';
    const capture = await captureResources(root, [resourceNode(body)]);
    // 标准 Markdown 把未定义引用降为文本，读者也原样显示；不读资源、不阻断导出。
    expect(capture.ok).toBe(true);
    expect(capture.diagnostics).toEqual([]);
    expect(capture.resources).toEqual({});
    expect(capture.references).toEqual([]);

    // 原文仍完整存在于导出 payload，未被删除或改写。
    const doc = document({
      nodes: [{ ...graphNode('n1', '节点一'), body, path: 'topics/t.md', fileHash: 'b'.repeat(64) }],
    });
    const html = renderTopicHtml({ document: doc, readerScript: READER_SCRIPT, readerStyles: READER_STYLES });
    const jsonStart = html.indexOf('>', html.indexOf('id="' + EXPORT_DATA_ELEMENT_ID + '"')) + 1;
    const parsed = JSON.parse(html.slice(jsonStart, html.indexOf('</script>', jsonStart))) as OfflineTopicDocument;
    expect(parsed.nodes[0]?.body).toBe(body);
    expect(parsed.resources).toEqual({});
  });

  it('still applies the resource limits to reference images', async () => {
    const root = await newRoot();
    await writeFile(root, 'resources/wrong.gif', PNG_HEAD);
    await writeFile(root, 'resources/big.png', Buffer.concat([PNG_HEAD, Buffer.alloc(4096)]));
    const mismatch = await captureResources(root, [resourceNode('![w][r]\n\n[r]: resources/wrong.gif')]);
    expect(codes(mismatch.diagnostics)).toContain('RESOURCE_TYPE_MISMATCH');
    const oversized = await captureResources(root, [resourceNode('![b][r]\n\n[r]: resources/big.png')], { maxFileBytes: 1024 });
    expect(codes(oversized.diagnostics)).toContain('RESOURCE_TOO_LARGE');
    const outside = await captureResources(root, [resourceNode('![o][r]\n\n[r]: ../secret.png')]);
    expect(codes(outside.diagnostics)).toContain('RESOURCE_UNSUPPORTED');
  });

  it('exports a PNG whose name has spaces and full-width punctuation end to end', async () => {
    const root = await newRoot();
    const name = '图（1） final.png';
    await writeFile(root, 'resources/' + name, PNG_HEAD);
    const body = '![示意图](<resources/图（1） final.png>)';
    const capture = await captureResources(root, [resourceNode(body)]);
    expect(capture.ok).toBe(true);
    expect(capture.resources['resources/' + name]).toBe('data:image/png;base64,' + PNG_HEAD.toString('base64'));

    const doc = document({ resources: capture.resources });
    const html = renderTopicHtml({ document: doc, readerScript: READER_SCRIPT, readerStyles: READER_STYLES });
    const jsonStart = html.indexOf('>', html.indexOf('id="' + EXPORT_DATA_ELEMENT_ID + '"')) + 1;
    const parsed = JSON.parse(html.slice(jsonStart, html.indexOf('</script>', jsonStart))) as OfflineTopicDocument;
    expect(parsed.resources['resources/' + name]).toBe(capture.resources['resources/' + name]);
    // 资源名只进入 JSON 数据，不进入可执行脚本。
    const scriptTag = /<script src="data:text\/javascript;base64,([^"]+)"><\/script>/.exec(html);
    const decoded = Buffer.from(scriptTag?.[1] ?? '', 'base64').toString('utf8');
    expect(decoded).toBe(READER_SCRIPT);
  });

  it('still refuses keys that are absolute or escape the workspace', () => {
    const dataUri = 'data:image/png;base64,' + PNG_HEAD.toString('base64');
    expect(() => renderTopicHtml({ document: document({ resources: { '/abs.png': dataUri } }), readerScript: READER_SCRIPT, readerStyles: READER_STYLES })).toThrow(ExportError);
    expect(() => renderTopicHtml({ document: document({ resources: { '../out.png': dataUri } }), readerScript: READER_SCRIPT, readerStyles: READER_STYLES })).toThrow(ExportError);
    expect(() => renderTopicHtml({ document: document({ resources: { 'resources/../out.png': dataUri } }), readerScript: READER_SCRIPT, readerStyles: READER_STYLES })).toThrow(ExportError);
    expect(() => renderTopicHtml({ document: document({ resources: { 'resources//a.png': dataUri } }), readerScript: READER_SCRIPT, readerStyles: READER_STYLES })).toThrow(ExportError);
    expect(() => renderTopicHtml({ document: document({ resources: { 'resources/a\u0000b.png': dataUri } }), readerScript: READER_SCRIPT, readerStyles: READER_STYLES })).toThrow(ExportError);
    expect(() => renderTopicHtml({ document: document({ resources: { 'C:/x.png': dataUri } }), readerScript: READER_SCRIPT, readerStyles: READER_STYLES })).toThrow(ExportError);
  });
});

describe('readReaderAssets', () => {
  it('reads a self-contained pair and fingerprints the build', async () => {
    const directory = await newRoot();
    await writeFile(directory, 'reader.js', READER_SCRIPT);
    await writeFile(directory, 'reader.css', READER_STYLES);
    const assets = await readReaderAssets({ directory });
    expect(assets.script).toBe(READER_SCRIPT);
    expect(assets.buildFingerprint).toHaveLength(64);
    expect(assets.directory).toBe(directory);
  });

  it('fails concretely for missing or externally dependent assets', async () => {
    const missing = await newRoot();
    await expect(readReaderAssets({ directory: missing })).rejects.toMatchObject({ code: 'READER_ASSETS_MISSING' });

    const external = await newRoot();
    await writeFile(external, 'reader.js', READER_SCRIPT);
    await writeFile(external, 'reader.css', '@import url("https://fonts.example/x.css");');
    await expect(readReaderAssets({ directory: external })).rejects.toMatchObject({ code: 'READER_ASSET_UNSAFE' });

    const imageUrl = await newRoot();
    await writeFile(imageUrl, 'reader.js', READER_SCRIPT);
    await writeFile(imageUrl, 'reader.css', '.a{background:url(/assets/a.png)}');
    await expect(readReaderAssets({ directory: imageUrl })).rejects.toMatchObject({ code: 'READER_ASSET_UNSAFE' });

    expect(() => assertSelfContainedStyles('@font-face{src:url("data:font/woff2;base64,AA")}')).not.toThrow();
  });
});

describe('resolveResourcePath', () => {
  it('only maps resources/ references and blocks escapes', () => {
    expect(resolveResourcePath('topics', 'resources/a.png')).toBe('resources/a.png');
    expect(resolveResourcePath('topics/nested', '../../resources/a.png')).toBe('resources/a.png');
    expect(resolveResourcePath('topics/nested', '../resources/a.png')).toBeNull();
    expect(resolveResourcePath('topics', '../../resources/a.png')).toBeNull();
    expect(resolveResourcePath('topics', '/etc/passwd')).toBeNull();
    expect(resolveResourcePath('topics', 'C:/x.png')).toBeNull();
    expect(resolveResourcePath('topics', 'http://x/a.png')).toBeNull();
    expect(resolveResourcePath('topics', 'topics/a.png')).toBeNull();
    expect(resolveResourcePath('topics', 'resources/a%20b.png')).toBe('resources/a b.png');
  });
});

function codes(diagnostics: Diagnostic[]): string[] {
  return diagnostics.map((diagnostic) => diagnostic.code);
}