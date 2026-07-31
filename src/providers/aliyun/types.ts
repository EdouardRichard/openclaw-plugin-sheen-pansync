export type AliyunRefreshTokenInput = {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  signal?: AbortSignal;
};

export type AliyunRefreshTokenResult = {
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
};

export type AliyunFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type AliyunTimeoutHandle = ReturnType<typeof setTimeout>;

export type AliyunHttpClientOptions = {
  baseUrl?: string;
  fetch?: AliyunFetch;
  clock?: () => number;
  scheduleTimeout?: (
    callback: () => void,
    delayMs: number,
  ) => AliyunTimeoutHandle;
  cancelTimeout?: (handle: AliyunTimeoutHandle) => void;
};
