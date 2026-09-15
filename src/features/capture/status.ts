import type { Workspace } from '../../contracts/domain';

export interface CaptureStatus { state: string; workspace: Workspace; aiExtraction: 'enabled' | 'disabled' | 'unavailable'; modelApproval: 'available' | 'not_configured' }
