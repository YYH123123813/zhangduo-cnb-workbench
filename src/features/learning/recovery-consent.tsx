import { useEffect, useRef, useState } from 'react';
import type { Result } from '../../contracts/api';
import type { RecoveryAnchorInput } from '../../contracts/recovery-anchor';
import type { NavigationProps } from '../../contracts/navigation';
import type { LearningRecoveryIdentity } from './operation-recovery';
import { retainLearningRecovery } from './recovery-anchor';
import { failure, success } from './errors';

export function useRecoveryConsent(retain: NavigationProps['retainOperationRecovery'], identity: LearningRecoveryIdentity) {
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const alive = useRef(false);
  const identityKey = JSON.stringify([identity.actorId, identity.workspaceId]);
  const currentIdentity = useRef(identityKey); currentIdentity.current = identityKey;
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { setExpiresAt(null); setNotice(''); }, [identityKey]);
  const before = async (build: (expiresAt: string) => Promise<RecoveryAnchorInput>): Promise<Result<true>> => {
    if (expiresAt) {
      const input = await build(expiresAt);
      if (!alive.current || currentIdentity.current !== identityKey) return failure('FORBIDDEN', '原页面身份已卸载，未保留或发送本次操作。');
      const result = await retainLearningRecovery(retain, identity, input);
      if (!result.ok) {
        if (alive.current && currentIdentity.current === identityKey) setNotice(`${result.error.message} 原操作 ID：${input.operation.operationId}`);
        return result;
      }
    }
    if (!alive.current || currentIdentity.current !== identityKey) return failure('FORBIDDEN', '原页面身份已卸载，未继续本次业务操作。');
    setExpiresAt(null); setNotice('');
    return success(true);
  };
  return { before, notice, expiresAt, select: (checked: boolean) => { setExpiresAt(checked ? new Date(Date.now() + 86_400_000).toISOString() : null); setNotice(''); } };
}

export function RecoveryConsent({ name, consent, disabled }: { name: string; consent: ReturnType<typeof useRecoveryConsent>; disabled?: boolean }) {
  return <><label className="learning-toggle"><input type="checkbox" name={name} checked={consent.expiresAt !== null} disabled={disabled} onChange={(event) => consent.select(event.target.checked)}/><span>另行同意为下一次操作保留原身份、操作 ID 和摘要，最长 24 小时，不含正文</span></label>
    {consent.expiresAt && <p>恢复身份到期：<time dateTime={consent.expiresAt}>{new Date(consent.expiresAt).toLocaleString('zh-CN')}</time>；不代替任务、作答或证据保存同意。</p>}
    {consent.notice && <p role="status" className="learning-notice">{consent.notice}</p>}</>;
}
