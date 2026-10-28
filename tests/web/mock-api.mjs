// Development-only fake API for UI smoke checks. It is NOT a production sample
// and must not be treated as workspace data. Run:
//   node tests/web/mock-api.mjs          (port 4399)
//   AICHAT_API_URL=http://127.0.0.1:4399 npm run dev:web
import { createServer } from 'node:http';

const nodes = [
  { id: 'n1', topicId: 't1', title: '记录的目的', summary: '保留有用的思路来路和关键转折，便于以后继续讨论。', number: '01', from: null, flow: 'root', state: 'agreed', important: false, revision: 1 },
  { id: 'n2', topicId: 't1', title: '原位维护', summary: '默认更新现有内容，不按聊天轮次新增副本。', number: '02', from: 'n1', flow: 'next', state: 'agreed', important: true, revision: 2 },
  { id: 'n3', topicId: 't1', title: '一个具体情境', summary: '某个观点改变后，怎样保留理解新观点所需的理由？', number: '01-01', from: 'n1', flow: 'branch', side: 'right', order: 10, state: 'proposed', important: false, revision: 1 },
  { id: 'n4', topicId: 't1', title: '侧枝继续', summary: '从 06-03 继续的局部讨论。', number: '01-02', from: 'n3', flow: 'next', state: 'agreed', important: false, revision: 1 },
  { id: 'n5', topicId: 't2', title: '另一个主题的卡片', summary: '跨主题文件连接。', number: '03', from: 'n2', flow: 'next', state: 'reference', important: false, revision: 1 },
];
const topics = [
  { id: 't1', key: '条目整理', title: '条目整理', nodeIds: ['n1','n2','n3','n4'], revision: 4 },
  { id: 't2', key: '协作方式', title: '协作方式', nodeIds: ['n5'], revision: 2 },
];
const body = '正文示例：这里说明**为什么**按主题归档。\n\n- 列表项\n- 第二项\n\n> 引用的一段话\n\n\`\`\`ts\nconst x = 1;\n\`\`\`\n';
const version = { instanceId: 'inst_demo_123456', revision: 7 };
const json = (res, code, data) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };

createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/api/workspace') return json(res, 200, { ...version, workspaceId: 'w_demo', name: '演示工作区', rootPath: 'D:/demo', activeNode: 'n2', stale: false, diagnostics: [] });
  if (url.pathname === '/api/graph') return json(res, 200, { ...version, workspaceId: 'w_demo', activeNode: 'n2', stale: false, diagnostics: [], nodes, topics });
  if (url.pathname.startsWith('/api/nodes/')) {
    const id = url.pathname.split('/').pop();
    const node = nodes.find((n) => n.id === id);
    if (!node) return json(res, 404, { error: { code: 'NOT_FOUND', message: 'no node' } });
    return json(res, 200, { ...version, node, body: body + '\n（' + node.title + '）', resources: {} });
  }
  if (url.pathname.startsWith('/api/topics/')) {
    const id = url.pathname.split('/').pop();
    const topic = topics.find((t) => t.id === id);
    if (!topic) return json(res, 404, { error: { code: 'NOT_FOUND', message: 'no topic' } });
    const topicNodes = topic.nodeIds.map((nid) => ({ ...nodes.find((n) => n.id === nid), body: body + '\n（' + nid + '）' }));
    return json(res, 200, { ...version, source: 'database', valid: true, topic, nodes: topicNodes, resources: {}, diagnostics: [] });
  }
  if (url.pathname === '/api/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write('retry: 10000\n\n');
    const timer = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => clearInterval(timer));
    return;
  }
  return json(res, 404, { error: { code: 'NOT_FOUND', message: 'unknown' } });
}).listen(4399, '127.0.0.1', () => console.log('mock api on 4399'));