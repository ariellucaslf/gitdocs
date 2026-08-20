'use client';

import React from 'react';
import { RepositoryItem, WebhookLogItem } from '@/lib/api';
import { ShieldCheck, GitPullRequest, Sparkles, FileEdit } from 'lucide-react';

interface StatsCardsProps {
  repositories: RepositoryItem[];
  logs: WebhookLogItem[];
}

export function StatsCards({ repositories, logs }: StatsCardsProps) {
  const activeReposCount = repositories.filter((r) => r.isActive).length;
  const autoCommitCount = repositories.filter((r) => r.isActive && r.autoCommitReadme).length;
  const successfulReviewsCount = logs.filter((l) => l.status === 'SUCCESS').length;

  const stats = [
    {
      title: 'Monitored Repositories',
      value: `${activeReposCount} / ${repositories.length}`,
      subtext: `${activeReposCount} active GitHub Webhooks`,
      icon: ShieldCheck,
      color: 'text-emerald-400',
      bg: 'bg-emerald-500/10',
      border: 'border-emerald-500/20',
    },
    {
      title: 'Auto-Commit README',
      value: `${autoCommitCount}`,
      subtext: 'Auto documentation enabled',
      icon: FileEdit,
      color: 'text-indigo-400',
      bg: 'bg-indigo-500/10',
      border: 'border-indigo-500/20',
    },
    {
      title: 'AI Reviews Completed',
      value: `${successfulReviewsCount}`,
      subtext: `${logs.length} total webhook events received`,
      icon: GitPullRequest,
      color: 'text-cyan-400',
      bg: 'bg-cyan-500/10',
      border: 'border-cyan-500/20',
    },
    {
      title: 'AI Engine',
      value: 'Gemini 1.5 Flash',
      subtext: 'Smart diff parsing & zero-cost setup',
      icon: Sparkles,
      color: 'text-purple-400',
      bg: 'bg-purple-500/10',
      border: 'border-purple-500/20',
    },
  ];

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
      {stats.map((stat, idx) => {
        const Icon = stat.icon;
        return (
          <div
            key={idx}
            className="p-5 rounded-2xl glass-panel relative overflow-hidden group hover:border-slate-600/80 transition-all duration-300 shadow-sm"
          >
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
                {stat.title}
              </span>
              <div className={`p-2 rounded-xl ${stat.bg} ${stat.border} border ${stat.color}`}>
                <Icon className="w-4 h-4" />
              </div>
            </div>

            <div className="mt-3">
              <div className="text-2xl font-bold text-slate-100 tracking-tight">{stat.value}</div>
              <p className="text-xs text-slate-400 mt-1">{stat.subtext}</p>
            </div>

            {/* Subtle glow background */}
            <div className="absolute -right-6 -bottom-6 w-20 h-20 bg-gradient-to-br from-white/5 to-transparent rounded-full blur-xl group-hover:scale-125 transition-transform" />
          </div>
        );
      })}
    </div>
  );
}
