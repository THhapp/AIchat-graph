import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import type { GraphResponse } from '../../shared/protocol.js';
import {
  loadReadingState,
  pruneReadingState,
  saveReadingState,
  type ReadingState,
} from './readingState.js';

export interface ReadingSession {
  reading: ReadingState | null;
  setReading: Dispatch<SetStateAction<ReadingState | null>>;
}

/**
 * Per-workspace local reading state. The saved value is loaded when the
 * workspace changes and pruned against the effective graph before being saved
 * again. Local state is a convenience: invalid or unavailable storage never
 * blocks reading.
 */
export function useReadingSession(
  workspaceId: string | null,
  sourceGraph: GraphResponse | null,
): ReadingSession {
  const [reading, setReading] = useState<ReadingState | null>(null);

  useEffect(() => {
    if (workspaceId === null) return;
    setReading(loadReadingState(workspaceId));
  }, [workspaceId]);

  useEffect(() => {
    if (workspaceId === null || reading === null || sourceGraph === null) return;
    const pruned = pruneReadingState(reading, sourceGraph);
    saveReadingState(workspaceId, pruned);
    // Covers panel, tree fold and per-topic records, not just selection/collapse.
    if (JSON.stringify(pruned) !== JSON.stringify(reading)) setReading(pruned);
  }, [workspaceId, reading, sourceGraph]);

  return { reading, setReading };
}
