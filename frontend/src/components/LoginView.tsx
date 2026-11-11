'use client';

import React from 'react';
import { signIn } from 'next-auth/react';
import {
  BookOpen,
  Sparkles,
  ShieldCheck,
  Zap,
  GitBranch,
  Github,
  CheckCircle,
} from 'lucide-react';

export function LoginView() {
  return (
    <div className="min-h-screen bg-background flex flex-col justify-between py-12 px-4 sm:px-6 lg:px-8 relative overflow-hidden">
      {/* Ambient background glows */}
      <div className="absolute -top-40 left-1/2 -translate-x-1/2 w-[700px] h-[400px] bg-gradient-to-tr from-emerald-600/20 via-teal-500/15 to-indigo-600/20 blur-[130px] pointer-events-none rounded-full" />

      {/* Main Content */}
      <div className="max-w-4xl mx-auto w-full my-auto text-center relative z-10 pt-8 pb-12">
        {/* Brand Badge */}
        <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-slate-800/80 border border-slate-700 text-xs font-medium text-slate-300 mb-8 backdrop-blur-md">
          <Sparkles className="w-3.5 h-3.5 text-emerald-400" />
          <span>AI-Powered GitHub Pull Request Bot & Documentation Agent</span>
        </div>

        {/* Hero Title */}
        <h1 className="text-4xl sm:text-6xl font-extrabold tracking-tight text-white leading-tight">
          Supercharge your PRs with{' '}
          <span className="bg-gradient-to-r from-emerald-400 via-teal-300 to-indigo-400 bg-clip-text text-transparent">
            Automated AI Reviews
          </span>
        </h1>

        <p className="mt-6 text-lg sm:text-xl text-slate-300 max-w-2xl mx-auto leading-relaxed">
          Connect your GitHub repositories in seconds. GitDocs analyzes incoming code diffs, posts structured review checklists, and suggests documentation changes for your approval.
        </p>

        {/* CTA Button */}
        <div className="mt-10 flex flex-col sm:flex-row items-center justify-center gap-4">
          <button
            onClick={() => signIn('github', { callbackUrl: '/' })}
            className="w-full sm:w-auto px-8 py-4 rounded-2xl bg-white hover:bg-slate-100 text-slate-950 font-bold text-base flex items-center justify-center gap-3 shadow-xl hover:scale-[1.02] active:scale-[0.98] transition-all duration-200"
          >
            <Github className="w-5 h-5" />
            <span>Continue with GitHub</span>
          </button>
        </div>

        {/* Feature Highlights Grid */}
        <div className="mt-16 grid grid-cols-1 sm:grid-cols-3 gap-6 text-left">
          <div className="p-6 rounded-2xl glass-panel">
            <div className="w-10 h-10 rounded-xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-emerald-400 mb-4">
              <Zap className="w-5 h-5" />
            </div>
            <h2 className="font-bold text-base text-slate-100">Structured AI Reviews</h2>
            <p className="text-xs text-slate-400 mt-2 leading-relaxed">
              Instant code reviews highlighting features, bug fixes, breaking changes and actionable checklists.
            </p>
          </div>

          <div className="p-6 rounded-2xl glass-panel">
            <div className="w-10 h-10 rounded-xl bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center text-indigo-400 mb-4">
              <BookOpen className="w-5 h-5" />
            </div>
            <h2 className="font-bold text-base text-slate-100">Review README Changes</h2>
            <p className="text-xs text-slate-400 mt-2 leading-relaxed">
              Keep your docs up to date effortlessly. Review a patch and explicitly approve it before a commit is made to the PR branch.
            </p>
          </div>

          <div className="p-6 rounded-2xl glass-panel">
            <div className="w-10 h-10 rounded-xl bg-cyan-500/10 border border-cyan-500/20 flex items-center justify-center text-cyan-400 mb-4">
              <ShieldCheck className="w-5 h-5" />
            </div>
            <h2 className="font-bold text-base text-slate-100">HMAC Webhook Security</h2>
            <p className="text-xs text-slate-400 mt-2 leading-relaxed">
              Secure webhook signature validation, server-side credentials and a self-hosted configuration.
            </p>
          </div>
        </div>
      </div>

      {/* Footer */}
      <footer className="text-center text-xs text-slate-500 py-4 border-t border-slate-800/40 relative z-10">
        GitDocs & PR-Committer • Built with Next.js, Express, PostgreSQL & Prisma
      </footer>
    </div>
  );
}
