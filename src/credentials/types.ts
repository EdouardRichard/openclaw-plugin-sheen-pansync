export type EncryptedEnvelopeV1 = {
  formatVersion: 1;
  algorithm: "aes-256-gcm";
  nonce: string;
  authTag: string;
  ciphertext: string;
};

export type CredentialRecord = {
  formatVersion: 2;
  credentialVersion: number;
  authorizationPageUrl: string;
  refreshApiUrl: string;
  refreshToken: string;
  accessToken: string;
  account: {
    userIdMasked: string;
    displayNameMasked?: string;
  };
  lastVerifiedAt: string;
  refreshState: RefreshState;
};

export type RefreshState = {
  status: "ready" | "degraded" | "rate_limited" | "reauth_required";
  notBefore?: string;
  failureCode?:
    | "TOKEN_ENDPOINT_UNAVAILABLE"
    | "RATE_LIMITED"
    | "REFRESH_TOKEN_REJECTED";
};
