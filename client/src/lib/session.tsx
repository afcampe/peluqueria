import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, setUnauthorizedHandler, tokenStore } from './api';
import { setLocaleConfig } from './format';
import type { PublicConfig, User } from './types';

interface Session {
  user: User | null;
  config: PublicConfig | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<User>;
  register: (data: { name: string; email: string; phone: string; password: string; acceptsEmail: boolean; acceptsWhatsapp: boolean; avatar?: string | null }) => Promise<User>;
  logout: () => void;
  setUser: (u: User) => void;
  reloadConfig: () => Promise<void>;
}

const Ctx = createContext<Session>(null!);
export const useSession = () => useContext(Ctx);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [loading, setLoading] = useState(true);

  const logout = useCallback(() => { tokenStore.set(null); setUser(null); }, []);
  const reloadConfig = useCallback(async () => {
    const c = await api.get<PublicConfig>('/public/config');
    setLocaleConfig(c.timezone, c.currency);
    setConfig(c);
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(logout);
    const loadUser = tokenStore.get() ? api.get<User>('/auth/me').then(setUser).catch(() => logout()) : Promise.resolve();
    Promise.all([loadUser, reloadConfig().catch(() => {})]).finally(() => setLoading(false));
  }, [logout, reloadConfig]);

  const auth = async (path: string, body: unknown) => {
    const r = await api.post<{ token: string; user: User }>(path, body);
    tokenStore.set(r.token);
    setUser(r.user);
    return r.user;
  };

  return (
    <Ctx.Provider value={{
      user, config, loading, logout, setUser, reloadConfig,
      login: (email, password) => auth('/auth/login', { email, password }),
      register: (data) => auth('/auth/register', data),
    }}>
      {children}
    </Ctx.Provider>
  );
}
