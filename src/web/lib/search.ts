import type { GraphNode, GraphResponse, GraphTopic } from '../../shared/protocol.js';

export interface SearchResults {
  nodes: GraphNode[];
  topics: GraphTopic[];
  trimmed: string;
}

/** Unicode substring match: Chinese needs no word segmentation. */
export function searchGraph(graph: GraphResponse, rawQuery: string): SearchResults {
  const query = rawQuery.trim().toLocaleLowerCase('zh-CN');
  if (query.length === 0) return { nodes: [], topics: [], trimmed: '' };
  const nodes = graph.nodes.filter((node) => {
    const haystack = (node.number + ' ' + node.title + ' ' + node.summary).toLocaleLowerCase('zh-CN');
    return haystack.includes(query);
  });
  const topics = graph.topics.filter((topic) => {
    return (topic.title + ' ' + topic.path).toLocaleLowerCase('zh-CN').includes(query);
  });
  return { nodes: nodes.slice(0, 60), topics: topics.slice(0, 20), trimmed: rawQuery.trim() };
}
