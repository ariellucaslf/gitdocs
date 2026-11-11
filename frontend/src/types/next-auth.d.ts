import { DefaultSession } from 'next-auth';

declare module 'next-auth' {
  interface Session {
    user: {
      id?: string;
      username?: string;
    } & DefaultSession['user'];
  }

  interface JWT {
    accessToken?: string;
    username?: string;
    githubId?: number;
  }
}
