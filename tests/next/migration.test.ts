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

function withRawDb<T>(dbPath: string, run: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(dbPath);
  try {
    return run(db);
  } finally {
    db.close();
  }
}

/** Turn a current v3 database into the historical v2 shape (no change batches). */
async function downgradeToV2(root: string): Promise<string> {
  const dbPath = path.join(root, 'graph.sqlite');
  withRawDb(dbPath, (db) => {
    db.exec('DROP TABLE IF EXISTS topic_changes');
    db.prepare("UPDATE meta SET value='2' WHERE key='schemaVersion'").run();
  });
  return dbPath;
}

/** Turn a current v3 database into the historical v1 shape (no batches, with state). */
async function downgradeToV1(root: string): Promise<string> {
  const dbPath = await downgradeToV2(root);
  withRawDb(dbPath, (db) => {
    db.exec("ALTER TABLE nodes ADD COLUMN state TEXT NOT NULL DEFAULT 'proposed'");
    db.exec("UPDATE nodes SET state='agreed'");
    db.prepare("UPDATE meta SET value='1' WHERE key='schemaVersion'").run();
  });
  return dbPath;
}

function schemaVersion(dbPath: string): string {
  return withRawDb(dbPath, (db) =>
    String((db.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get() as { value: string }).value),
  );
}

function hasStateColumn(dbPath: string): boolean {
  return withRawDb(dbPath, (db) =>
    (db.prepare('PRAGMA table_info(nodes)').all() as Array<{ name: string }>)
      .some((column) => column.name === 'state'),
  );
}

function hasTopicChangesTable(dbPath: string): boolean {
  return withRawDb(dbPath, (db) => {
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='topic_changes'")
      .get();
    return row !== undefined && row !== null;
  });
}

function expectNoChangeBatches(store: GraphStore): void {
  expect(store.latestChangeSummary('t_test')).toBeNull();
  expect(store.latestChangeDetail('t_test')).toBeNull();
  expect(store.nodeChange('t_test', 'n_' + 'a'.repeat(32))).toBeNull();
  expect(store.changeSummaries()).toEqual({});
  expect(store.changeBatchRequestId('t_test')).toBeNull();
}

describe('schema v1 -> v2 -> v3', () => {
  it('read-only open reads v1 without writing, upgrading or creating topic_changes', async () => {
    const root = await tempRoot();
    const store = GraphStore.create(root, '升级库');
    const data = seed();
    store.importState(data);
    store.close();
    const dbPath = await downgradeToV1(root);

    const readonly = GraphStore.open(root, { readonly: true });
    expect(readonly.schemaVersion()).toBe(1);
    const snapshot = readonly.snapshot();
    expect(snapshot.nodes.map((node) => node.id)).toEqual(data.nodes.map((node) => node.id));
    expectNoChangeBatches(readonly);
    readonly.close();

    expect(schemaVersion(dbPath)).toBe('1');
    expect(hasStateColumn(dbPath)).toBe(true);
    expect(hasTopicChangesTable(dbPath)).toBe(false);
  });

  it('writable open upgrades v1 through v2 to v3, preserving content, versions and recent fields', async () => {
    const root = await tempRoot();
    const store = GraphStore.create(root, '升级库');
    const data = seed();
    store.importState(data);
    store.close();
    const dbPath = await downgradeToV1(root);

    const upgraded = GraphStore.open(root);
    expect(upgraded.schemaVersion()).toBe(SCHEMA_VERSION);
    const snapshot = upgraded.snapshot();
    // v1 had no before-content, so the new batch table must stay empty.
    expectNoChangeBatches(upgraded);
    upgraded.close();

    expect(schemaVersion(dbPath)).toBe(String(SCHEMA_VERSION));
    expect(hasStateColumn(dbPath)).toBe(false);
    expect(hasTopicChangesTable(dbPath)).toBe(true);
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

    // Reopen after migration: no second structural or version change.
    const again = GraphStore.open(root);
    expect(again.schemaVersion()).toBe(SCHEMA_VERSION);
    expect(again.snapshot().revision).toBe(data.workspace.revision);
    again.close();
  });

  it('read-only v2 opens without creating topic_changes or writing; change helpers are safe empty', async () => {
    const root = await tempRoot();
    const store = GraphStore.create(root, '升级库');
    const data = seed();
    store.importState(data);
    store.close();
    const dbPath = await downgradeToV2(root);

    const readonly = GraphStore.open(root, { readonly: true });
    expect(readonly.schemaVersion()).toBe(2);
    const snapshot = readonly.snapshot();
    expect(snapshot.workspaceId).toBe(data.workspace.id);
    expect(snapshot.topics).toEqual([{
      ...data.topics[0],
      nodeIds: data.nodes.map((node) => node.id).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    }]);
    // Legacy last-change metadata stays readable, but it is not a diff batch.
    expect(snapshot.topics[0]?.lastChangeAt).toBe(data.topics[0]?.lastChangeAt);
    expectNoChangeBatches(readonly);
    readonly.close();

    expect(schemaVersion(dbPath)).toBe('2');
    expect(hasTopicChangesTable(dbPath)).toBe(false);
  });

  it('writable v2 -> v3 only creates topic_changes and bumps meta, without fabricating batches', async () => {
    const root = await tempRoot();
    const store = GraphStore.create(root, '升级库');
    const data = seed();
    store.importState(data);
    store.close();
    const dbPath = await downgradeToV2(root);

    const upgraded = GraphStore.open(root);
    expect(upgraded.schemaVersion()).toBe(SCHEMA_VERSION);
    const snapshot = upgraded.snapshot();
    // Existing content, revisions and legacy recent-change fields are untouched.
    expect(snapshot.workspaceId).toBe(data.workspace.id);
    expect(snapshot.name).toBe(data.workspace.name);
    expect(snapshot.activeNode).toBe(data.workspace.activeNode);
    expect(snapshot.revision).toBe(data.workspace.revision);
    expect(snapshot.topics).toEqual([{
      ...data.topics[0],
      nodeIds: data.nodes.map((node) => node.id).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    }]);
    expect(snapshot.nodes.map((node) => ({ id: node.id, revision: node.revision })))
      .toEqual(expect.arrayContaining(data.nodes.map((node) => ({ id: node.id, revision: node.revision }))));
    // v2 batch history does not exist and must never be fabricated from last_change_*.
    expectNoChangeBatches(upgraded);
    upgraded.close();

    expect(schemaVersion(dbPath)).toBe(String(SCHEMA_VERSION));
    expect(hasTopicChangesTable(dbPath)).toBe(true);
  });

  it('writable v1 upgrade tolerates an already existing topic_changes table', async () => {
    const root = await tempRoot();
    const store = GraphStore.create(root, '升级库');
    const data = seed();
    store.importState(data);
    store.close();
    const dbPath = await downgradeToV1(root);
    // 异常/中止的旧库可能残留空 change 表；v3 升级必须只建表而不失败。
    withRawDb(dbPath, (db) => {
      db.exec(`
        CREATE TABLE topic_changes(
          topic_id TEXT PRIMARY KEY REFERENCES topics(id),
          request_id TEXT NOT NULL,
          at TEXT NOT NULL,
          nodes_json TEXT NOT NULL
        );
      `);
    });

    const upgraded = GraphStore.open(root);
    expect(upgraded.schemaVersion()).toBe(SCHEMA_VERSION);
    expectNoChangeBatches(upgraded);
    expect(upgraded.snapshot().revision).toBe(data.workspace.revision);
    upgraded.close();
    expect(schemaVersion(dbPath)).toBe(String(SCHEMA_VERSION));
    expect(hasTopicChangesTable(dbPath)).toBe(true);
    expect(hasStateColumn(dbPath)).toBe(false);
  });

  it('new databases use schema v3 without node state and with the change table', async () => {
    const root = await tempRoot();
    const store = GraphStore.create(root, '新库');
    expect(store.schemaVersion()).toBe(SCHEMA_VERSION);
    expectNoChangeBatches(store);
    store.close();
    const dbPath = path.join(root, 'graph.sqlite');
    expect(schemaVersion(dbPath)).toBe(String(SCHEMA_VERSION));
    expect(hasStateColumn(dbPath)).toBe(false);
    expect(hasTopicChangesTable(dbPath)).toBe(true);
  });
});
