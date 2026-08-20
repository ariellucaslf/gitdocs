'use client';

import React, { useState } from 'react';
import { WebhookLogItem } from '@/lib/api';
import {
  CheckCircle2,
  XCircle,
  Clock,
  ExternalLink,
  AlertTriangle,
  FileCode,
  Search,
  RefreshCw,
  GitPullRequest,
} from 'lucide-react';

interface WebhookLogsTableProps {
  logs: WebhookLogItem[];
  onRefresh: () => void;
}

export function WebhookLogsTable({ logs, onRefresh }: WebhookLogsTableProps) {
  const [search, setSearch] = useState('');
  const [selectedError, setSelectedError] = useState<string | null>(null);

  const filteredLogs = logs.filter((log) => {
    const q = search.toLowerCase();
    return (
      log.prTitle.toLowerCase().includes(q) ||
      log.repository.fullName.toLowerCase().includes(q) ||
      log.prNumber.toString().includes(q) ||
      log.status.toLowerCase().includes(q)
    );
  });

  const formatBytes = (bytes: number): string => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
  };

  const formatDate = (isoString: string): string => {
    const date = new Date(isoString);
    return date.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  return (
    <section>
      {/* Search and Refresh */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-4 mb-6">
        <div className="relative flex-1 max-w-md">
          <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search logs by PR title, repo or status..."
            className="w-full bg-surface-elevated/80 border border-surface-border/80 rounded-xl pl-10 pr-4 py-2.5 text-sm text-slate-200 placeholder-slate-500 focus:outline-none focus:border-emerald-500/60 focus:ring-1 focus:ring-emerald-500/30 transition-all"
          />
        </div>

        <button
          onClick={onRefresh}
          className="flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-surface-elevated/80 border border-surface-border/60 text-slate-300 hover:text-emerald-400 hover:bg-emerald-500/10 transition-colors text-sm font-medium"
        >
          <RefreshCw className="w-4 h-4" />
          <span>Refresh Activity</span>
        </button>
      </div>

      {/* Table Panel */}
      <div className="glass-panel rounded-2xl overflow-hidden border border-surface-border">
        {filteredLogs.length === 0 ? (
          <div className="text-center py-16 px-4">
            <div className="w-12 h-12 rounded-full bg-slate-800 flex items-center justify-center mx-auto mb-3 text-slate-400">
              <GitPullRequest className="w-6 h-6" />
            </div>
            <h3 className="text-base font-semibold text-slate-200">No webhook activity yet</h3>
            <p className="text-sm text-slate-400 max-w-md mx-auto mt-1">
              When a Pull Request is opened or synchronized in your monitored repositories, the AI review and commit logs will appear here.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm text-slate-300">
              <thead className="bg-slate-900/80 border-b border-surface-border text-xs uppercase tracking-wider text-slate-400">
                <tr>
                  <th className="py-3.5 px-4 font-semibold">Status</th>
                  <th className="py-3.5 px-4 font-semibold">Repository</th>
                  <th className="py-3.5 px-4 font-semibold">Pull Request</th>
                  <th className="py-3.5 px-4 font-semibold">Diff Size</th>
                  <th className="py-3.5 px-4 font-semibold">Date & Time</th>
                  <th className="py-3.5 px-4 font-semibold text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {filteredLogs.map((log) => {
                  return (
                    <tr key={log.id} className="hover:bg-slate-800/30 transition-colors">
                      {/* Status */}
                      <td className="py-3.5 px-4 whitespace-nowrap">
                        {log.status === 'SUCCESS' && (
                          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                            <CheckCircle2 className="w-3.5 h-3.5" /> Reviewed
                          </span>
                        )}
                        {log.status === 'PENDING' && (
                          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-amber-500/10 text-amber-400 border border-amber-500/20">
                            <Clock className="w-3.5 h-3.5 animate-pulse" /> Processing
                          </span>
                        )}
                        {log.status === 'ERROR' && (
                          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-rose-500/10 text-rose-400 border border-rose-500/20">
                            <XCircle className="w-3.5 h-3.5" /> Error
                          </span>
                        )}
                      </td>

                      {/* Repository */}
                      <td className="py-3.5 px-4 font-mono text-xs text-slate-300">
                        {log.repository.fullName}
                      </td>

                      {/* Pull Request */}
                      <td className="py-3.5 px-4">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-mono font-bold text-emerald-400">
                            #{log.prNumber}
                          </span>
                          <span className="text-sm font-medium text-slate-100 line-clamp-1">
                            {log.prTitle}
                          </span>
                        </div>
                      </td>

                      {/* Diff Size */}
                      <td className="py-3.5 px-4 whitespace-nowrap text-xs text-slate-400 font-mono">
                        <div className="flex items-center gap-1">
                          <FileCode className="w-3.5 h-3.5 text-slate-500" />
                          {formatBytes(log.rawDiffSize)}
                        </div>
                      </td>

                      {/* Date & Time */}
                      <td className="py-3.5 px-4 whitespace-nowrap text-xs text-slate-400">
                        {formatDate(log.createdAt)}
                      </td>

                      {/* Actions */}
                      <td className="py-3.5 px-4 whitespace-nowrap text-right">
                        {log.responseCommentUrl && (
                          <a
                            href={log.responseCommentUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-400 hover:text-emerald-300 hover:underline"
                          >
                            <span>View Review</span>
                            <ExternalLink className="w-3.5 h-3.5" />
                          </a>
                        )}

                        {log.status === 'ERROR' && log.errorMessage && (
                          <button
                            onClick={() => setSelectedError(log.errorMessage)}
                            className="inline-flex items-center gap-1 text-xs font-semibold text-rose-400 hover:text-rose-300 hover:underline"
                          >
                            <AlertTriangle className="w-3.5 h-3.5" />
                            <span>View Error</span>
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Error Modal */}
      {selectedError && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-surface rounded-2xl border border-rose-500/30 max-w-lg w-full p-6 shadow-2xl">
            <div className="flex items-center gap-2 text-rose-400 mb-3">
              <AlertTriangle className="w-5 h-5" />
              <h4 className="font-bold text-base text-slate-100">Processing Error Details</h4>
            </div>
            <pre className="bg-slate-900/90 rounded-xl p-4 text-xs font-mono text-rose-300 whitespace-pre-wrap max-h-60 overflow-y-auto border border-rose-500/20">
              {selectedError}
            </pre>
            <div className="mt-5 flex justify-end">
              <button
                onClick={() => setSelectedError(null)}
                className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 text-sm font-semibold rounded-xl transition-colors"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
