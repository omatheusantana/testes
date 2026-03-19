import axios, { AxiosInstance, AxiosRequestConfig, Method } from "axios";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ApiKeyResponse {
  apiKey: string;
  expiresAt?: number; // unix timestamp (ms)
}

export interface GatewayClientOptions {
  baseURL: string;
  /** Fetches the api key for a given endpoint/method */
  fetchApiKey: (endpoint: string, method: Method) => Promise<ApiKeyResponse>;
  /** Field name where the apiKey goes in the request body (default: "apiKey") */
  apiKeyField?: string;
  /** Extra axios defaults */
  axiosConfig?: AxiosRequestConfig;
}

// ─── In-memory key cache ───────────────────────────────────────────────────────

interface CacheEntry {
  apiKey: string;
  expiresAt: number;
}

const keyCache = new Map<string, CacheEntry>();

function getCacheKey(endpoint: string, method: Method) {
  return `${method.toUpperCase()}::${endpoint}`;
}

function getCachedKey(endpoint: string, method: Method): string | null {
  const entry = keyCache.get(getCacheKey(endpoint, method));
  if (!entry) return null;
  // Expire 30s early to avoid edge cases
  if (Date.now() > entry.expiresAt - 30_000) {
    keyCache.delete(getCacheKey(endpoint, method));
    return null;
  }
  return entry.apiKey;
}

function setCachedKey(
  endpoint: string,
  method: Method,
  apiKey: string,
  expiresAt?: number
) {
  keyCache.set(getCacheKey(endpoint, method), {
    apiKey,
    // If no expiry provided, cache for 5 minutes
    expiresAt: expiresAt ?? Date.now() + 5 * 60 * 1000,
  });
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createGatewayClient(options: GatewayClientOptions): AxiosInstance {
  const {
    baseURL,
    fetchApiKey,
    apiKeyField = "apiKey",
    axiosConfig = {},
  } = options;

  const instance = axios.create({ baseURL, ...axiosConfig });

  // ── Request interceptor: inject api key into body ──────────────────────────
  instance.interceptors.request.use(async (config) => {
    const method = (config.method ?? "get") as Method;
    const endpoint = config.url ?? "";

    let apiKey = getCachedKey(endpoint, method);

    if (!apiKey) {
      const result = await fetchApiKey(endpoint, method);
      apiKey = result.apiKey;
      setCachedKey(endpoint, method, apiKey, result.expiresAt);
    }

    // Inject into body for all verbs that send a body
    const bodyMethods: Method[] = ["post", "put", "patch", "delete"];
    if (bodyMethods.includes(method.toLowerCase() as Method)) {
      config.data = { ...(config.data ?? {}), [apiKeyField]: apiKey };
    } else {
      // For GET/HEAD, inject as a query param as fallback
      config.params = { ...(config.params ?? {}), [apiKeyField]: apiKey };
    }

    return config;
  });

  // ── Response interceptor: surface gateway-level errors ────────────────────
  instance.interceptors.response.use(
    (response) => response,
    (error) => {
      // Invalidate cached key on 401 so next call fetches a fresh one
      if (error.response?.status === 401) {
        const method = (error.config?.method ?? "get") as Method;
        const endpoint = error.config?.url ?? "";
        keyCache.delete(getCacheKey(endpoint, method));
      }
      return Promise.reject(error);
    }
  );

  return instance;
}
