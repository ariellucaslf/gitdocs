'use client';

import React, { useEffect, useState, useCallback, useRef } from 'react';
import { useSession } from 'next-auth/react';
import { Navbar } from '@/components/Navbar';
import { StatsCards } from '@/components/StatsCards';
import { RepositoryList } from '@/components/RepositoryList';
import { WebhookLogsTable } from '@/components/WebhookLogsTable';
import { LoginView } from '@/components/LoginView';
import {
  fetchRepositories,
  fetchWebhookLogs,
  RepositoryItem,
  WebhookLogItem,
} from '@/lib/api';
import { Loader2 } from 'lucide-react';

export default function DashboardPage() {
  const { data: session, status } = useSession();
  const [activeTab, setActiveTab] = useState<'repositories' | 'logs'>('repositories');

  const [repositories, setRepositories] = useState<RepositoryItem[]>([]);
  const [logs, setLogs] = useState<WebhookLogItem[]>([]);
  const [repoPage, setRepoPage] = useState(1);
  const [logPage, setLogPage] = useState(1);
  const [repoPages, setRepoPages] = useState(1);
  const [logPages, setLogPages] = useState(1);
  const [aggregates, setAggregates] = useState<Record<string, number | string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const requestVersion = useRef(0);
  const loadData = useCallback(async () => {
    if (!session?.user) return;
    const version = ++requestVersion.current;

    try {
      setError(null);
      const [reposData, logsData] = await Promise.all([
        fetchRepositories(repoPage),
        fetchWebhookLogs(logPage),
      ]);

      if (version !== requestVersion.current) return;
      setRepositories(reposData.items);
      setLogs(logsData.items);
      setRepoPages(reposData.pagination.totalPages);
      setLogPages(logsData.pagination.totalPages);
      setAggregates({ ...reposData.aggregates, ...logsData.aggregates });
    } catch (err) {
      console.error('Error loading dashboard data:', err);
      if (version !== requestVersion.current) return;
      setError(err instanceof Error ? err.message : 'Failed to connect to backend API');
    } finally {
      if (version === requestVersion.current) setLoading(false);
    }
  }, [session?.user, repoPage, logPage]);

  useEffect(() => {
    if (session?.user) {
      loadData();
    } else if (status === 'unauthenticated') {
      setLoading(false);
    }
  }, [session?.user, status, loadData]);

  // Loading Session State
  if (status === 'loading' || (status === 'authenticated' && loading)) {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center gap-3">
        <Loader2 className="w-8 h-8 animate-spin text-emerald-400" />
        <p className="text-sm font-medium text-slate-400">Loading your GitDocs workspace...</p>
      </div>
    );
  }

  // Unauthenticated State (Landing / Login)
  if (status === 'unauthenticated' || !session) {
    return <LoginView />;
  }

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <Navbar
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        logsCount={logs.length}
      />

      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Error notification banner if API is unreachable */}
        {error && (
          <div className="mb-6 p-4 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-300 text-sm flex items-center justify-between">
            <span role="alert">⚠️ {error}</span>
            <button
              onClick={loadData}
              className="px-3 py-1 bg-rose-500/20 hover:bg-rose-500/30 rounded-lg text-xs font-semibold"
            >
              Retry
            </button>
          </div>
        )}

        {/* Top Summary Stats */}
        <StatsCards aggregates={aggregates} />

        {/* Tab View */}
        {activeTab === 'repositories' ? (
          <RepositoryList
            repositories={repositories}
            onRefresh={loadData}
          />
        ) : (
          <WebhookLogsTable logs={logs} onRefresh={loadData} />
        )}
        <div className="flex justify-center items-center gap-4 mt-6 text-sm text-slate-300">
          <button className="px-3 py-2 border border-slate-700 rounded-lg disabled:opacity-40" disabled={(activeTab === 'repositories' ? repoPage : logPage) <= 1}
            onClick={() => activeTab === 'repositories' ? setRepoPage(p => p - 1) : setLogPage(p => p - 1)}>Previous page</button>
          <span>Page {activeTab === 'repositories' ? repoPage : logPage} of {activeTab === 'repositories' ? repoPages : logPages}</span>
          <button className="px-3 py-2 border border-slate-700 rounded-lg disabled:opacity-40" disabled={activeTab === 'repositories' ? repoPage >= repoPages : logPage >= logPages}
            onClick={() => activeTab === 'repositories' ? setRepoPage(p => p + 1) : setLogPage(p => p + 1)}>Next page</button>
        </div>
      </main>
    </div>
  );
}
