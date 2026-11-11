import { NextAuthOptions } from 'next-auth';
import GithubProvider from 'next-auth/providers/github';

export const authOptions: NextAuthOptions = {
  providers: [
    GithubProvider({
      clientId: process.env.GITHUB_CLIENT_ID || '',
      clientSecret: process.env.GITHUB_CLIENT_SECRET || '',
      authorization: {
        params: {
          scope: 'read:user user:email repo write:repo_hook',
        },
      },
    }),
  ],
  callbacks: {
    async jwt({ token, account }) {
      if (account?.access_token) {
        // Provision credentials while they are available on the OAuth server callback.
        // The resulting JWT contains identity only, never the GitHub token.
        const backend = process.env.BACKEND_INTERNAL_URL || 'http://localhost:4000/api';
        const response = await fetch(`${backend}/auth/me`, {
          headers: { Authorization: `Bearer ${account.access_token}` },
          cache: 'no-store',
          signal: AbortSignal.timeout(15000),
        });
        if (!response.ok) throw new Error('Unable to connect GitHub account to GitDocs');
        const result = await response.json();
        if (!result.success || !result.data?.id) throw new Error('Invalid account provisioning response');
        token.sub = result.data.id;
        token.githubId = result.data.githubId;
        token.username = result.data.username;
        token.identityVersion = 2;
      }
      delete token.accessToken;
      // Sessions predating the server-only identity exchange must sign in again.
      if (token.identityVersion !== 2) return {};
      return token;
    },
    async session({ session, token }) {
      // NOTE (ADR 0002, V21): accessToken is strictly kept on server, NEVER exposed to client session
      if (session.user) {
        session.user.username = token.username as string | undefined;
        session.user.id = token.sub;
      }
      return session;
    },
  },
  pages: {
    signIn: '/',
  },
  secret: process.env.NEXTAUTH_SECRET,
};
