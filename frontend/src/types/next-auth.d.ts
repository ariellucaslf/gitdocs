import { DefaultSession } from 'next-auth';

declare module 'next-auth' {
  interface Session {
    accessToken?: string;
    user: {
      id?: string;
      username?: string;
    } & DefaultSession['user'];
  }

  interface JWT {
    accessToken?: string;
    username?: string;
  }
}
