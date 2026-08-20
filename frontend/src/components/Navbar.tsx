'use client';

import React from 'react';
import { signOut, useSession } from 'next-auth/react';
import { GitPullRequest, LogOut, BookOpen, Layers, Activity } from 'lucide-react';

interface NavbarProps {
  activeTab: 'repositories' | 'logs';
  setActiveTab: (tab: 'repositories' | 'logs') => void;
  logsCount?: number;
}

export function Navbar({ activeTab, setActiveTab, logsCount }: NavbarProps) {
  const { data: session } = useSession();

  return (
    <header className="sticky top-0 z-50 border-b border-surface-border/80 bg-background/80 backdrop-blur-md">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
        {/* Brand */}
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-emerald-500 via-teal-500 to-indigo-500 p-0.5 flex items-center justify-center shadow-lg shadow-emerald-500/20">
            <div className="w-full h-full bg-background rounded-[10px] flex items-center justify-center">
              <BookOpen className="w-5 h-5 text-emerald-400" />
            </div>
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="font-bold text-lg tracking-tight bg-gradient-to-r from-white via-slate-200 to-slate-400 bg-clip-text text-transparent">
                GitDocs
              </span>
              <span className="text-xs px-2 py-0.5 font-medium rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                Bot & AI Review
              </span>
            </div>
            <p className="text-xs text-slate-400 hidden sm:block">Automated PR Reviews & Documentation Commits</p>
          </div>
        </div>

        {/* Navigation Tabs */}
        <nav className="flex items-center gap-1.5 p-1 bg-surface-elevated/80 rounded-xl border border-surface-border/60">
          <button
            onClick={() => setActiveTab('repositories')}
            className={`flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-sm font-medium transition-all ${
              activeTab === 'repositories'
                ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 shadow-sm'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/40'
            }`}
          >
            <Layers className="w-4 h-4" />
            <span>Repositories</span>
          </button>

          <button
            onClick={() => setActiveTab('logs')}
            className={`flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-sm font-medium transition-all ${
              activeTab === 'logs'
                ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 shadow-sm'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/40'
            }`}
          >
            <Activity className="w-4 h-4" />
            <span>Activity Logs</span>
            {typeof logsCount === 'number' && logsCount > 0 && (
              <span className="px-1.5 py-0.2 text-[11px] rounded-full bg-slate-700 text-slate-300">
                {logsCount}
              </span>
            )}
          </button>
        </nav>

        {/* User profile & actions */}
        <div className="flex items-center gap-3">
          {session?.user && (
            <div className="flex items-center gap-2.5 pl-3 border-l border-surface-border">
              {session.user.image ? (
                <img
                  src={session.user.image}
                  alt={session.user.name || 'GitHub User'}
                  className="w-8 h-8 rounded-full ring-2 ring-emerald-500/30"
                />
              ) : (
                <div className="w-8 h-8 rounded-full bg-slate-800 flex items-center justify-center font-bold text-xs text-slate-300">
                  {session.user.name?.[0] || 'U'}
                </div>
              )}
              <div className="hidden md:block text-left">
                <p className="text-xs font-semibold text-slate-200">{session.user.name}</p>
                <p className="text-[11px] text-slate-400">@{session.user.username || 'github'}</p>
              </div>

              <button
                onClick={() => signOut({ callbackUrl: '/' })}
                title="Sign out"
                className="p-2 rounded-lg text-slate-400 hover:text-rose-400 hover:bg-rose-500/10 transition-colors"
              >
                <LogOut className="w-4 h-4" />
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
