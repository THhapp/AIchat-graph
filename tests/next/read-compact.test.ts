import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GraphStore } from '../../src/next/store.js';
import { readView, type ReadRequest } from '../../src/next/read.js';
import type { ReadViewResponse } from '../../src/next/protocol.js';

const roots: string[] = [];
const stores: GraphStore[] = [];

async function fixture(): Promise<{ store: GraphStore; root: string; topicId: string; rootId: string; nextId: string; branchId: string; bodies: Record<string, string> }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aichat-read-'));
  roots.push(root);
  const topicId = 't_read';
  const rootId = 'n_root';
  const nextId = 'n_next';
  const branchId = 'n_branch';
  const bodies: Record<string, string> = {
    [rootId]: '根正文。\n\n第二段。',
    [nextId]: '续正文。',
    [branchId]: '分支正文。\n\n分支第二段。',
  };
  const store = GraphStore.create(root, '读取验收');
  stores.push(store);
  store.importState({
    workspace: { id: 'w_read', name: '读取验收', activeNode: rootId, revision: 4 },
    topics: [{ id: topicId, key: 'read', title: '读取主题', revision: 2, lastChangeAt: null, lastChangeIds: [] }],
    nodes: [
      { id: rootId, topicId, title: '根', body: bodies[rootId] ?? '', summary: '根摘要', from: null, flow: 'root', description: null, side: null, order: null, important: true, revision: 2 },
      { id: nextId, topicId, title: '续', body: bodies[nextId] ?? '', summary: null, from: rootId, flow: 'next', description: '继续', side: null, order: null, important: false, revision: 1 },
      { id: branchId, topicId, title: '分支', body: bodies[branchId] ?? '', summary: null, from: rootId, flow: 'branch', description: '分支理由', side: 'right', order: 10, important: false, revision: 1 },
    ],
  });
  return { store, root, topicId, rootId, nextId, branchId, bodies };
}

afterEach(async () => {
  for (const store of stores.splice(0)) { try { store.close(); } catch { /* already closed */ } }
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
});

function view(store: GraphStore, request: ReadRequest): ReadViewResponse {
  return readView(store.snapshot(), request);
}

describe('compact read projections', () => {
  it('omits repeated identity/body fields from structure and outer scope stays compact', async () => {
    const f = await fixture();
    const full = view(f.store, { view: 'structure', topicId: f.topicId, budget: 20_000 });
    expect(full.scope.kind).toBe('topic');
    expect(full.items.length).toBe(3);
    for (const item of full.items) {
      expect(item).not.toHaveProperty('body');
      expect(item).not.toHaveProperty('range');
      expect(item.node).not.toHaveProperty('topicId');
    }

    const subtree = view(f.store, { view: 'structure', topicId: f.topicId, from: f.rootId, budget: 20_000 });
    expect(subtree.scope).toMatchObject({ kind: 'subtree', from: f.rootId });
    expect(subtree.items.map((item) => item.node.id).sort()).toEqual([f.rootId, f.nextId, f.branchId].sort());

    const content = view(f.store, { view: 'content', topicId: f.topicId, nodeIds: [f.rootId, f.nextId], budget: 20_000 });
    expect(content.scope).toMatchObject({ kind: 'nodes', nodeIds: [f.rootId, f.nextId] });
    expect(content.items[0]).toMatchObject({ body: f.bodies[f.rootId], range: { start: 0, total: (f.bodies[f.rootId] ?? '').length } });
    expect(content.items[0]?.node).not.toHaveProperty('topicId');
  });

  it('resume gives the anchor metadata once and uses a compact topic scope', async () => {
    const f = await fixture();
    const response = view(f.store, { view: 'resume', topicId: f.topicId, anchor: f.rootId, budget: 20_000 });
    expect(response.scope.kind).toBe('topic');
    expect(response.anchorId).toBe(f.rootId);
    expect(response).not.toHaveProperty('anchor');
    expect(response.items[0]).toMatchObject({ role: 'anchor', body: f.bodies[f.rootId] });
    const anchorItems = response.items.filter((item) => item.node.id === f.rootId);
    expect(anchorItems).toHaveLength(1);
  });

  it('cursor pages a topic range without repeating ids and preserves content slice length', async () => {
    const f = await fixture();
    const first = view(f.store, { view: 'structure', topicId: f.topicId, budget: 1000 });
    if (first.page.next === undefined) {
      // Very small synthetic pages are still valid; this fixture must page at 700.
      throw new Error('fixture did not produce a page cursor');
    }
    const decoded = JSON.parse(Buffer.from(first.page.next, 'base64url').toString('utf8')) as { scope: { kind: string; nodeIds?: unknown } };
    expect(decoded.scope.kind).toBe('topic');
    expect(decoded.scope.nodeIds).toBeUndefined();
    let page = first;
    const ids: string[] = [];
    let guard = 0;
    while (true) {
      guard += 1;
      if (guard > 20) throw new Error('cursor loop');
      ids.push(...page.items.map((item) => item.node.id));
      if (page.page.next === undefined) break;
      page = view(f.store, { view: 'structure', topicId: f.topicId, budget: 1000, cursor: page.page.next });
      expect(page.scope.kind).toBe('topic');
    }
    expect(ids.sort()).toEqual([f.rootId, f.nextId, f.branchId].sort());

    const body = '零一二三四五六七八九十甲乙丙丁戊己庚辛壬癸';
    const long = await fixture();
    // Replace the root body through a fresh imported fixture.
    const store2 = GraphStore.create(path.join(long.root, 'second'), '长正文');
  stores.push(store2);
    const topic2 = 't_long';
    store2.importState({
      workspace: { id: 'w_long', name: '长正文', activeNode: 'n_long', revision: 2 },
      topics: [{ id: topic2, key: 'long', title: '长正文', revision: 1, lastChangeAt: null, lastChangeIds: [] }],
      nodes: [{ id: 'n_long', topicId: topic2, title: '长', body, summary: null, from: null, flow: 'root', description: null, side: null, order: null, important: false, revision: 1 }],
    });
    let page2 = view(store2, { view: 'content', topicId: topic2, nodeIds: ['n_long'], budget: 1000, length: 3 });
    const text: string[] = [];
    guard = 0;
    while (true) {
      guard += 1;
      if (guard > 30) throw new Error('body cursor loop');
      for (const item of page2.items) if (item.body !== undefined) text.push(item.body);
      if (page2.page.next === undefined) break;
      const raw = JSON.parse(Buffer.from(page2.page.next, 'base64url').toString('utf8')) as { length: number; scope: { kind: string; nodeIds?: string[] } };
      expect(raw.length).toBe(3);
      expect(raw.scope.kind).toBe('nodes');
      page2 = view(store2, { view: 'content', topicId: topic2, budget: 1000, cursor: page2.page.next });
    }
    expect(text.join('')).toBe(body);
    });
});
