export interface SemanticQueryResult {
  hits: { objectId: string; score: number; text: string }[];
  snapshotRevision: string;
  indexRevision: string | null;
  coverage: 'current' | 'stale' | 'partial' | 'unavailable';
}
