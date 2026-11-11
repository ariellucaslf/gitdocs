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
    async jwt({ token, account, profile }) {
      if (account && account.access_token) {
        token.accessToken = account.access_token;
      }
      if (profile && typeof profile === 'object') {
        if ('login' in profile) {
          token.username = profile.login as string;
        }
        if ('id' in profile) {
          token.githubId = profile.id as number;
        }
      }
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
