import { useEffect, useState } from 'react';

export interface ServerConfig {
  domain: string;
  rp_id: string;
  has_custom_theme: boolean;
  db_encrypted: boolean;
  tls_enabled: boolean;
}

let cache: ServerConfig | null = null;
let inflight: Promise<ServerConfig | null> | null = null;

/**
 * Fetches /api/v1/config once per page load and shares the result. Returns
 * null until the first response lands so callers can show a neutral state
 * (instead of falsely claiming "encrypted").
 */
export function useServerConfig(): ServerConfig | null {
  const [config, setConfig] = useState<ServerConfig | null>(cache);

  useEffect(() => {
    if (cache) {
      setConfig(cache);
      return;
    }
    if (!inflight) {
      inflight = fetch('/api/v1/config')
        .then((res) => (res.ok ? (res.json() as Promise<ServerConfig>) : null))
        .then((data) => {
          if (data) cache = data;
          return data;
        })
        .catch(() => null);
    }
    let cancelled = false;
    inflight.then((data) => {
      if (!cancelled && data) setConfig(data);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return config;
}
