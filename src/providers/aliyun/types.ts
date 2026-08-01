export type OpenListRefreshInput = {
  refreshApiUrl: string;
  refreshToken: string;
  signal?: AbortSignal;
};

export type OpenListRefreshResult = {
  accessToken: string;
  refreshToken: string;
};

export interface AliyunTokenService {
  refresh(input: OpenListRefreshInput): Promise<OpenListRefreshResult>;
}

export type AliyunFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;
