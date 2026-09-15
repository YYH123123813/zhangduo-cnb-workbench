import { useEffect, useState } from 'react';
import { RefreshCw, CircleAlert } from 'lucide-react';
import { apiRequest } from './api-client';

export function ModuleStatus({ title, feature }: { title: string; feature: string }) {
  const [state, setState] = useState('正在检查');
  const [loading, setLoading] = useState(false);
  async function refresh() {
    setLoading(true);
    try {
      const result = await apiRequest<{ state: string }>(`/api/${feature}/status`);
      setState(result.ok ? result.data.state : result.error.code === 'NOT_IMPLEMENTED' ? '待实现' : '暂不可用');
    } catch { setState('连接失败'); }
    finally { setLoading(false); }
  }
  useEffect(() => { void refresh(); }, [feature]);
  return <section className="module"><header className="module-heading"><h1>{title}</h1><button className="icon-button" aria-label="刷新状态" title="刷新状态" disabled={loading} onClick={() => void refresh()}><RefreshCw size={18}/></button></header><div className="state-line" role="status"><CircleAlert size={18}/><span>{state}</span></div><dl className="properties"><div><dt>CNB 工作区</dt><dd>尚未连接</dd></div><div><dt>正式知识</dt><dd>尚无记录</dd></div><div><dt>模型调用</dt><dd>未启用</dd></div></dl></section>;
}
