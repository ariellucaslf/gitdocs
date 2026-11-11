'use client';
import { useState } from 'react';
import { actOnProposal, DocProposal, fetchProposals } from '@/lib/api';

export function DocProposals({ repositoryId }: { repositoryId: string }) {
  const [open, setOpen] = useState(false);
  const [proposals, setProposals] = useState<DocProposal[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [reviewed, setReviewed] = useState<Record<string, boolean>>({});
  async function load() {
    setBusy(true); setError(''); setOpen(true);
    try { setProposals(await fetchProposals(repositoryId)); } catch (e) { setError(e instanceof Error ? e.message : 'Unable to load proposals'); }
    finally { setBusy(false); }
  }
  async function act(proposal: DocProposal, action: 'approve' | 'reject') {
    setBusy(true); setError('');
    try { await actOnProposal(proposal.id, action); setProposals(await fetchProposals(repositoryId)); }
    catch (e) { setError(e instanceof Error ? e.message : 'Unable to apply action'); setProposals(await fetchProposals(repositoryId).catch(() => proposals)); }
    finally { setBusy(false); }
  }
  return <>
    <button className="text-xs text-indigo-300 underline" onClick={load}>Review documentation proposals</button>
    {open && <div role="dialog" aria-modal="true" aria-label="Documentation proposals" className="fixed inset-0 z-[60] bg-black/80 flex items-center justify-center p-4">
      <section className="bg-slate-900 border border-slate-700 rounded-xl p-6 w-full max-w-3xl max-h-[85vh] overflow-auto text-slate-200">
        <div className="flex justify-between gap-4 mb-4"><h2 className="font-bold">Documentation proposals</h2><button onClick={() => setOpen(false)}>Close</button></div>
        {error && <p role="alert" className="text-rose-300 mb-4">{error}</p>}
        {busy && <p role="status">Working…</p>}
        {!busy && proposals.length === 0 && <p>No documentation proposals yet.</p>}
        {proposals.map(proposal => <article key={proposal.id} className="border-t border-slate-700 py-4 space-y-3">
          <h3 className="font-semibold">PR #{proposal.prNumber}: {proposal.title}</h3>
          <p className="text-xs break-all">Status: {proposal.status} · Analyzed commit: {proposal.headSha}</p>
          <p className="text-sm">{proposal.description}</p>
          {proposal.operations.map((operation, index) => <div key={index} className="text-xs space-y-1">
            <p>Replace:</p><pre className="bg-rose-950/40 p-3 whitespace-pre-wrap break-words">{operation.oldText || '(new file)'}</pre>
            <p>With:</p><pre className="bg-emerald-950/40 p-3 whitespace-pre-wrap break-words">{operation.newText}</pre>
          </div>)}
          <details><summary className="cursor-pointer text-sm">Preview resulting README</summary><pre className="p-3 bg-slate-950 text-xs whitespace-pre-wrap">{proposal.previewContent}</pre></details>
          {proposal.failureReason && <p className="text-rose-300 text-xs">{proposal.failureReason}</p>}
          {proposal.commitUrl && <a href={proposal.commitUrl} target="_blank" rel="noopener noreferrer" className="text-emerald-300 underline">View commit</a>}
          {proposal.isFork && <p className="text-amber-300 text-xs">Fork PR: suggestion available for manual use; automated writing is disabled.</p>}
          {proposal.status === 'PENDING_APPROVAL' && <>
            <label className="flex gap-2 text-sm"><input type="checkbox" checked={!!reviewed[proposal.id]} onChange={e => setReviewed({ ...reviewed, [proposal.id]: e.target.checked })} />I reviewed these changes for the commit shown above.</label>
            <div className="flex gap-4 text-sm">
              <button className="rounded bg-emerald-700 px-3 py-2 disabled:opacity-40" disabled={busy || !reviewed[proposal.id] || proposal.isFork} onClick={() => act(proposal, 'approve')}>Approve and commit</button>
              <button disabled={busy} onClick={() => act(proposal, 'reject')}>Reject</button>
            </div>
          </>}
          {proposal.status === 'APPLYING' && <button disabled={busy} className="text-sm underline" onClick={() => act(proposal, 'approve')}>Reconcile application</button>}
        </article>)}
      </section>
    </div>}
  </>;
}
