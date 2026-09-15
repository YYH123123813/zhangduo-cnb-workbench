export const SCOPES = {
  workspaceRead: 'workspace:read', conversationRead: 'conversation:read', conversationWrite: 'conversation:write',
  taskRead: 'task:read', taskWrite: 'task:write',
  candidateRead: 'candidate:read', candidateWrite: 'candidate:write', draftRead: 'draft:read', draftWrite: 'draft:write',
  knowledgeRead: 'knowledge:read', knowledgeWrite: 'knowledge:write', knowledgeIndex: 'knowledge:index',
  modelExtract: 'model:extract', modelAnswer: 'model:answer', modelReview: 'model:review',
  evidenceRead: 'evidence:read', evidenceWrite: 'evidence:write', dataExport: 'data:export', dataDelete: 'data:delete',
  settingsRead: 'settings:read', settingsWrite: 'settings:write', auditRead: 'audit:read',
} as const;
export type Scope = typeof SCOPES[keyof typeof SCOPES];
