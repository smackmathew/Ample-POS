/** The server answered with an error status. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** The request never got an answer (offline, DNS, timeout). It may or may not have reached the server. */
export class NetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NetworkError';
  }
}

export interface ApiClientOptions {
  baseUrl: string;
  token?: string;
  tenantId?: string;
  deviceCredential?: string;
  timeoutMs?: number;
  /** Injectable for tests. Defaults to the global fetch. */
  fetch?: typeof fetch;
}

export class ApiClient {
  constructor(private readonly options: ApiClientOptions) {}

  with(changes: Partial<ApiClientOptions>): ApiClient {
    return new ApiClient({ ...this.options, ...changes });
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }

  post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('POST', path, body);
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const { baseUrl, token, tenantId, deviceCredential, timeoutMs = 15_000 } = this.options;
    const doFetch = this.options.fetch ?? fetch;
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = `Bearer ${token}`;
    if (tenantId) headers['X-Tenant-Id'] = tenantId;
    if (deviceCredential) headers['X-Device-Credential'] = deviceCredential;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await doFetch(`${baseUrl.replace(/\/+$/, '')}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      throw new NetworkError(err instanceof Error ? err.message : 'Network request failed');
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text().catch(() => '');
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      data = text;
    }
    if (!res.ok) {
      const message = (data as { message?: unknown } | undefined)?.message;
      throw new ApiError(res.status, typeof message === 'string' ? message : Array.isArray(message) ? message.join(', ') : res.statusText, data);
    }
    return data as T;
  }
}
