'use client';

import React, { useState } from 'react';
import { RepositoryItem, toggleRepository } from '@/lib/api';
import {
  Search,
  ExternalLink,
  Lock,
  Globe,
  CheckCircle2,
  XCircle,
  Loader2,
  RefreshCw,
  GitBranch,
  Sparkles,
} from 'lucide-react';

interface RepositoryListProps {
  repositories: RepositoryItem[];
  token: string;
  onRefresh: () => void;
}

export function RepositoryList({ repositories, token, onRefresh }: RepositoryListProps) {
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'all' | 'active' | 'inactive'>('all');
  const [loadingRepoId, setLoadingRepoId] = useState<number | null>(null);

  const filteredRepos = repositories.filter((repo) => {
    const matchesSearch =
      repo.fullName.toLowerCase().includes(search.toLowerCase()) ||
      repo.name.toLowerCase().includes(search.toLowerCase());

    if (filter === 'active') return matchesSearch && repo.isActive;
    if (filter === 'inactive') return matchesSearch && !repo.isActive;
    return matchesSearch;
  });

  const handleToggle = async (
    repo: RepositoryItem,
    field: 'isActive' | 'autoCommitReadme',
    value: boolean
  ) => {
    try {
      setLoadingRepoId(repo.id);

      const isActivating = field === 'isActive' ? value : repo.isActive;
      const autoCommit = field === 'autoCommitReadme' ? value : repo.autoCommitReadme;

      // Backend webhook listener public endpoint URL
      const webhookUrl = `${window.location.origin.replace('3000', '4000')}/api/webhooks`;

      await toggleRepository(token, {
        githubRepoId: repo.id,
        name: repo.name,
        fullName: repo.fullName,
        owner: repo.owner,
        isActive: isActivating,
        autoCommitReadme: autoCommit,
        webhookUrl: isActivating ? webhookUrl : undefined,
      });

      onRefresh();
    } catch (err) {
      console.error('Failed to toggle repository setting:', err);
      alert('Failed to update repository settings on GitHub or server.');
    } finally {
      setLoadingRepoId(null);
    }
  };

  return (
    <section>
      {/* Header with Search and Filters */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-4 mb-6">
        <div className="relative flex-1 max-w-md">
          <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search your GitHub repositories..."
            className="w-full bg-surface-elevated/80 border border-surface-border/80 rounded-xl pl-10 pr-4 py-2.5 text-sm text-slate-200 placeholder-slate-500 focus:outline-none focus:border-emerald-500/60 focus:ring-1 focus:ring-emerald-500/30 transition-all"
          />
        </div>

        <div className="flex items-center gap-2">
          {/* Filter Pills */}
          <div className="flex items-center p-1 bg-surface-elevated/80 rounded-xl border border-surface-border/60 text-xs">
            <button
              onClick={() => setFilter('all')}
              className={`px-3 py-1.5 rounded-lg font-medium transition-all ${
                filter === 'all'
                  ? 'bg-slate-700 text-white'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              All ({repositories.length})
            </button>
            <button
              onClick={() => setFilter('active')}
              className={`px-3 py-1.5 rounded-lg font-medium transition-all ${
                filter === 'active'
                  ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Active ({repositories.filter((r) => r.isActive).length})
            </button>
            <button
              onClick={() => setFilter('inactive')}
              className={`px-3 py-1.5 rounded-lg font-medium transition-all ${
                filter === 'inactive'
                  ? 'bg-slate-700 text-white'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Inactive ({repositories.filter((r) => !r.isActive).length})
            </button>
          </div>

          <button
            onClick={onRefresh}
            title="Refresh repositories"
            className="p-2.5 rounded-xl bg-surface-elevated/80 border border-surface-border/60 text-slate-400 hover:text-emerald-400 hover:bg-emerald-500/10 transition-colors"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Repositories Grid */}
      {filteredRepos.length === 0 ? (
        <div className="text-center py-16 px-4 glass-panel rounded-2xl border border-dashed border-slate-700">
          <div className="w-12 h-12 rounded-full bg-slate-800 flex items-center justify-center mx-auto mb-3 text-slate-400">
            <Search className="w-6 h-6" />
          </div>
          <h3 className="text-base font-semibold text-slate-200">No repositories found</h3>
          <p className="text-sm text-slate-400 max-w-sm mx-auto mt-1">
            {search
              ? `No repositories matched "${search}". Try clearing your search filter.`
              : 'No repositories available in your GitHub account.'}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
          {filteredRepos.map((repo) => {
            const isLoading = loadingRepoId === repo.id;

            return (
              <div
                key={repo.id}
                className={`p-5 rounded-2xl glass-panel relative flex flex-col justify-between transition-all duration-300 ${
                  repo.isActive
                    ? 'border-emerald-500/30 hover:border-emerald-500/50 glow-emerald'
                    : 'border-surface-border hover:border-slate-600'
                }`}
              >
                <div>
                  {/* Top Bar: Privacy & GitHub Link */}
                  <div className="flex items-center justify-between gap-2 mb-3">
                    <div className="flex items-center gap-1.5">
                      {repo.private ? (
                        <span className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-amber-500/10 text-amber-400 border border-amber-500/20">
                          <Lock className="w-3 h-3" /> Private
                        </span>
                      ) : (
                        <span className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-sky-500/10 text-sky-400 border border-sky-500/20">
                          <Globe className="w-3 h-3" /> Public
                        </span>
                      )}

                      {repo.defaultBranch && (
                        <span className="flex items-center gap-1 text-[11px] text-slate-400">
                          <GitBranch className="w-3 h-3" /> {repo.defaultBranch}
                        </span>
                      )}
                    </div>

                    <a
                      href={repo.htmlUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-slate-400 hover:text-slate-100 p-1 transition-colors"
                      title="Open on GitHub"
                    >
                      <ExternalLink className="w-4 h-4" />
                    </a>
                  </div>

                  {/* Repository Title */}
                  <h4 className="font-bold text-base text-slate-100 group-hover:text-emerald-400 transition-colors break-words">
                    {repo.name}
                  </h4>
                  <p className="text-xs text-slate-400 font-mono mt-0.5 mb-2">{repo.fullName}</p>

                  <p className="text-xs text-slate-300 line-clamp-2 min-h-[32px]">
                    {repo.description || 'No description provided.'}
                  </p>
                </div>

                {/* Automation Toggles */}
                <div className="mt-5 pt-4 border-t border-slate-800/80 space-y-3">
                  {/* Webhook AI Review Toggle */}
                  <div className="flex items-center justify-between">
                    <div>
                      <span className="text-xs font-semibold text-slate-200 block">
                        AI PR Review
                      </span>
                      <span className="text-[11px] text-slate-400">
                        {repo.isActive ? 'Webhook monitoring active' : 'Monitoring paused'}
                      </span>
                    </div>

                    <button
                      disabled={isLoading}
                      onClick={() => handleToggle(repo, 'isActive', !repo.isActive)}
                      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none ${
                        repo.isActive ? 'bg-emerald-500' : 'bg-slate-700'
                      } ${isLoading ? 'opacity-50 cursor-not-allowed' : ''}`}
                    >
                      <span
                        className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                          repo.isActive ? 'translate-x-6' : 'translate-x-1'
                        }`}
                      />
                    </button>
                  </div>

                  {/* README Autocommit Toggle */}
                  {repo.isActive && (
                    <div className="flex items-center justify-between pt-2 border-t border-slate-800/40">
                      <div>
                        <span className="text-xs font-semibold text-slate-200 flex items-center gap-1.5">
                          <Sparkles className="w-3.5 h-3.5 text-indigo-400" />
                          Auto-commit README
                        </span>
                        <span className="text-[11px] text-slate-400">
                          Commits suggested docs on PR branch
                        </span>
                      </div>

                      <button
                        disabled={isLoading}
                        onClick={() =>
                          handleToggle(repo, 'autoCommitReadme', !repo.autoCommitReadme)
                        }
                        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none ${
                          repo.autoCommitReadme ? 'bg-indigo-500' : 'bg-slate-700'
                        } ${isLoading ? 'opacity-50 cursor-not-allowed' : ''}`}
                      >
                        <span
                          className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                            repo.autoCommitReadme ? 'translate-x-6' : 'translate-x-1'
                          }`}
                        />
                      </button>
                    </div>
                  )}

                  {isLoading && (
                    <div className="flex items-center gap-1.5 text-[11px] text-emerald-400 justify-end pt-1">
                      <Loader2 className="w-3 h-3 animate-spin" /> Updating GitHub...
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
