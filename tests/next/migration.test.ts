import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { GraphStore, SCHEMA_VERSION } from '../../src/next/store.js';
import type { NodeRecord, TopicRecord, WorkspaceRecord } from '../../src/next/model.js';

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aichat-migration-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop() as string;
    await fs.rm(root, { recursive: true, force: true });
  }
});

function seed(): { workspace: WorkspaceRecord; topics: TopicRecord[]; nodes: NodeRecord[] } {
  const rootId = 'n_' + 'a'.repeat(32);
  const branchId = 'n_' + 'b'.repeat(32);
  return {
    workspace: { id: 'w_test', name: '升级库', activeNode: branchId, revision: 7 },
    topics: [{
      id: 't_test', key: 'topic', title: '主题', revision: 3,
      lastChangeAt: '2026-10-01T00:00:00.000Z', lastChangeIds: [rootId, branchId],
    }],
    nodes: [
      {
        id: rootId, topicId: 't_test', title: '根卡', body: '根正文', summary: '根摘要',
        from: null, flow: 'root', description: null, side: null, order: null,
        important: true, revision: 4,
      },
      {
        id: branchId, topicId: 't_test', title: '分支卡', body: '分支正文', summary: null,
        from: rootId, flow: 'branch', description: '从这里分出', side: 'right', order: 10,
        important: false, revision: 9,
      },
    ],
  };
}

/** Turn a current v2 database into the historical v1 shape without losing rows. */
async function downgradeToV1(root: string): Promise<string> {
  const dbPath = path.join(root, 'graph.sqlite');
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("ALTER TABLE nodes ADD COLUMN state TEXT NOT NULL DEFAULT 'proposed'");
    db.exec("UPDATE nodes SET state='agreed'");
    db.prepare("UPDATE meta SET value='1' WHERE key='schemaVersion'").run();
  } finally {
    db.close();
  }
  return dbPath;
}

function schemaVersion(dbPath: string): string {
  const db = new DatabaseSync(dbPath);
  try {
    return String((db.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get() as { value: string }).value);
  } finally {
    db.close();
  }
}

function hasStateColumn(dbPath: string): boolean {
  const db = new DatabaseSync(dbPath);
  try {
    const columns = db.prepare('PRAGMA table_info(nodes)').all() as Array<{ name: string }>;
    return columns.some((column) => column.name === 'state');
  } finally {
    db.close();
  }
}

describe('schema v1 -> v2', () => {
  it('read-only open reads v1 without writing or upgrading it', async () => {
    const root = await tempRoot();
    const store = GraphStore.create(root, '升级库');
    const data = seed();
    store.importState(data);
    store.close();
    const dbPath = await downgradeToV1(root);

    const readonly = GraphStore.open(root, { readonly: true });
    const snapshot = readonly.snapshot();
    expect(snapshot.nodes.map((node) => node.id)).toEqual(data.nodes.map((node) => node.id));
    readonly.close();

    expect(schemaVersion(dbPath)).toBe('1');
    expect(hasStateColumn(dbPath)).toBe(true);
  });

  it('writable open upgrades v1 once, preserving content, versions and recent changes', async () => {
    const root = await tempRoot();
    const store = GraphStore.create(root, '升级库');
    const data = seed();
    store.importState(data);
    store.close();
    const dbPath = await downgradeToV1(root);

    const upgraded = GraphStore.open(root);
    const snapshot = upgraded.snapshot();
    upgraded.close();

    expect(schemaVersion(dbPath)).toBe(String(SCHEMA_VERSION));
    expect(hasStateColumn(dbPath)).toBe(false);
    expect(snapshot.workspaceId).toBe(data.workspace.id);
    expect(snapshot.name).toBe(data.workspace.name);
    expect(snapshot.activeNode).toBe(data.workspace.activeNode);
    expect(snapshot.revision).toBe(data.workspace.revision);
    expect(snapshot.topics).toEqual([{
      ...data.topics[0],
      nodeIds: data.nodes.map((node) => node.id).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    }]);
    expect(snapshot.nodes.map((node) => ({
      id: node.id, title: node.title, body: node.body, summary: node.summary,
      from: node.from, flow: node.flow, description: node.description,
      side: node.side, order: node.order, important: node.important,
      revision: node.revision,
    }))).toEqual(expect.arrayContaining(data.nodes.map((node) => ({
      id: node.id, title: node.title, body: node.body, summary: node.summary,
      from: node.from, flow: node.flow, description: node.description,
      side: node.side, order: node.order, important: node.important,
      revision: node.revision,
    }))));

    // Reopen after migration: no second structural change.
    const again = GraphStore.open(root);
    expect(again.snapshot().revision).toBe(data.workspace.revision);
    again.close();
  });

  it('new databases use v2 and have no state column', async () => {
    const root = await tempRoot();
    const store = GraphStore.create(root, '新库');
    store.close();
    const dbPath = path.join(root, 'graph.sqlite');
    expect(schemaVersion(dbPath)).toBe(String(SCHEMA_VERSION));
    expect(hasStateColumn(dbPath)).toBe(false);
  });
});
