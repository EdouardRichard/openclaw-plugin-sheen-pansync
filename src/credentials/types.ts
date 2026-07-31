export type EncryptedEnvelopeV1 = {
  formatVersion: 1;
  algorithm: "aes-256-gcm";
  nonce: string;
  authTag: string;
  ciphertext: string;
};

export type CredentialRecord = {
  formatVersion: 1;
  credentialVersion: number;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  accessToken: string;
  accessTokenExpiresAt: string;
  account: {
    userIdMasked: string;
    displayNameMasked?: string;
  };
  lastVerifiedAt: string;
};
