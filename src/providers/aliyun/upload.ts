import { Readable } from "node:stream";
import type {
  ProviderUploadInput,
  ProviderUploadResult,
  ProviderOperationOptions,
  RemoteDirectory,
} from "../../contracts.js";
import type { PanSyncErrorCode } from "../../errors.js";
import { PanSyncError } from "../../errors.js";
import type { ResolvedWorkspaceFile } from "../../workspace/path-guard.js";
import { ALIYUN_OPENAPI_BASE_URL } from "./constants.js";
import type { AliyunFetch } from "./types.js";

const MIN_PART_SIZE = 20 * 1024 * 1024;
const MAX_PARTS = 10_000;
const MAX_CONCURRENT_PUTS = 3;
const UPLOAD_URL_REFRESH_AGE_MS = 50 * 60 * 1_000;
const READ_CHUNK_SIZE = 64 * 1024;
const ACCESS_TOKEN_FAILURE_CODES = new Set([
  "accesstokeninvalid",
  "accesstokenexpired",
  "i400jd",
]);

export type AliyunRemoteDirectory = RemoteDirectory & {
  providerState: {
    driveId: string;
  };
};

export type AliyunProviderUploadInput = Omit<
  ProviderUploadInput,
  "remoteDirectory"
> & {
  remoteDirectory: AliyunRemoteDirectory;
};

export type AliyunTokenRefresher = {
  forceRefresh(expectedAccessToken?: string, options?: ProviderOperationOptions): Promise<string>;
};

export type AliyunAuthorizedClientOptions = {
  baseUrl?: string;
  fetch?: AliyunFetch;
  tokenManager: AliyunTokenRefresher;
};

export type AliyunPostOptions = {
  failureCode: PanSyncErrorCode;
  retryTokenFailure?: boolean;
  allowAlreadyExisting?: boolean;
  signal?: AbortSignal;
};

export type AliyunPostResult = {
  accessToken: string;
  body: unknown;
  alreadyExisting: boolean;
};

type UploadPart = {
  partNumber: number;
  uploadUrl: string;
  acquiredAt: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function nonEmptyString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function responseCode(body: unknown): string {
  if (!isRecord(body)) {
    return "";
  }
  const code = body.code ?? body.error;
  return typeof code === "string" ? code.toLowerCase() : "";
}

function isAccessTokenFailure(body: unknown): boolean {
  return ACCESS_TOKEN_FAILURE_CODES.has(responseCode(body));
}

function isCapacityFailure(body: unknown): boolean {
  const code = responseCode(body);
  return (
    code.includes("spacenotenough")
    || code.includes("not_enough_space")
    || code.includes("insufficientspace")
    || code.includes("quota")
    || code.includes("capacity")
  );
}

export function isAlreadyExistingName(body: unknown): boolean {
  const code = responseCode(body);
  return (
    code.includes("alreadyexist")
    || code.includes("already_exist")
    || code.includes("filenameconflict")
  );
}

function mappedFailure(
  status: number,
  body: unknown,
  fallback: PanSyncErrorCode,
): PanSyncError {
  if (status === 429) {
    return new PanSyncError("RATE_LIMITED");
  }
  if (isCapacityFailure(body)) {
    return new PanSyncError("QUOTA_EXCEEDED");
  }
  return new PanSyncError(fallback);
}

export class AliyunAuthorizedClient {
  readonly #baseUrl: string;
  readonly #fetch: AliyunFetch;

  constructor(private readonly options: AliyunAuthorizedClientOptions) {
    this.#baseUrl = options.baseUrl ?? ALIYUN_OPENAPI_BASE_URL;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  get fetch(): AliyunFetch {
    return this.#fetch;
  }

  async post(
    endpointPath: string,
    accessToken: string,
    requestBody: unknown,
    options: AliyunPostOptions,
  ): Promise<AliyunPostResult> {
    let token = accessToken;
    let refreshed = false;

    while (true) {
      let response: Response;
      let body: unknown;
      try {
        response = await this.#fetch(
          new URL(endpointPath, this.#baseUrl),
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${token}`,
              "content-type": "application/json",
            },
            body: JSON.stringify(requestBody),
            ...(options.signal === undefined ? {} : { signal: options.signal }),
          },
        );
        body = await response.json().catch(() => undefined);
      } catch {
        throw new PanSyncError(options.failureCode);
      }

      if (
        isAccessTokenFailure(body)
        && options.retryTokenFailure !== false
      ) {
        if (refreshed) {
          throw new PanSyncError("AUTHORIZATION_REVOKED");
        }
        token = options.signal === undefined
          ? await this.options.tokenManager.forceRefresh(token)
          : await this.options.tokenManager.forceRefresh(token, {
            signal: options.signal,
          });
        refreshed = true;
        continue;
      }

      if (!response.ok) {
        if (
          options.allowAlreadyExisting === true
          && isAlreadyExistingName(body)
        ) {
          return {
            accessToken: token,
            body,
            alreadyExisting: true,
          };
        }
        throw mappedFailure(response.status, body, options.failureCode);
      }

      return {
        accessToken: token,
        body,
        alreadyExisting: false,
      };
    }
  }
}

function partCount(fileSize: number, partSize: number): number {
  return fileSize === 0 ? 0 : Math.ceil(fileSize / partSize);
}

function parseCreatedUpload(
  body: unknown,
  expectedParts: number,
  acquiredAt: number,
): {
  fileId: string;
  uploadId: string;
  remoteName?: string;
  parts: UploadPart[];
} {
  if (!isRecord(body)) {
    throw new PanSyncError("UPLOAD_FAILED");
  }
  const fileId = nonEmptyString(body, "file_id");
  const uploadId = nonEmptyString(body, "upload_id");
  const partInfo = body.part_info_list;
  if (
    fileId === undefined
    || uploadId === undefined
    || !Array.isArray(partInfo)
    || partInfo.length !== expectedParts
  ) {
    throw new PanSyncError("UPLOAD_FAILED");
  }

  const parts = partInfo.map((entry): UploadPart => {
    if (!isRecord(entry)) {
      throw new PanSyncError("UPLOAD_FAILED");
    }
    const partNumber = entry.part_number;
    const uploadUrl = nonEmptyString(entry, "upload_url");
    if (
      typeof partNumber !== "number"
      || !Number.isInteger(partNumber)
      || partNumber < 1
      || uploadUrl === undefined
    ) {
      throw new PanSyncError("UPLOAD_FAILED");
    }
    return { partNumber, uploadUrl, acquiredAt };
  });
  parts.sort((left, right) => left.partNumber - right.partNumber);
  if (
    parts.some((part, index) => part.partNumber !== index + 1)
  ) {
    throw new PanSyncError("UPLOAD_FAILED");
  }

  const remoteName =
    nonEmptyString(body, "file_name")
    ?? nonEmptyString(body, "name");
  return {
    fileId,
    uploadId,
    ...(remoteName === undefined ? {} : { remoteName }),
    parts,
  };
}

function parseRefreshedPartUrl(
  body: unknown,
  expectedPartNumber: number,
  acquiredAt: number,
): UploadPart {
  if (!isRecord(body) || !Array.isArray(body.part_info_list)) {
    throw new PanSyncError("UPLOAD_FAILED");
  }
  const matching = body.part_info_list.find((entry) =>
    isRecord(entry) && entry.part_number === expectedPartNumber
  );
  if (!isRecord(matching)) {
    throw new PanSyncError("UPLOAD_FAILED");
  }
  const uploadUrl = nonEmptyString(matching, "upload_url");
  if (uploadUrl === undefined) {
    throw new PanSyncError("UPLOAD_FAILED");
  }
  return {
    partNumber: expectedPartNumber,
    uploadUrl,
    acquiredAt,
  };
}

async function putPart(
  client: AliyunAuthorizedClient,
  stream: Readable,
  uploadUrl: string,
  contentLength: number,
  signal: AbortSignal,
): Promise<void> {
  try {
    const init: RequestInit & { duplex: "half" } = {
      method: "PUT",
      headers: {
        "content-length": String(contentLength),
      },
      body: stream as unknown as BodyInit,
      duplex: "half",
      signal,
    };
    const response = await client.fetch(uploadUrl, init);
    if (!response.ok) {
      if (response.status === 429) {
        throw new PanSyncError("RATE_LIMITED");
      }
      throw new PanSyncError("UPLOAD_FAILED");
    }
  } catch (error) {
    if (error instanceof PanSyncError) {
      throw error;
    }
    throw new PanSyncError("UPLOAD_FAILED");
  } finally {
    stream.destroy();
  }
}

function rangeStream(
  file: ResolvedWorkspaceFile,
  start: number,
  length: number,
): Readable {
  async function* chunks(): AsyncGenerator<Buffer> {
    let position = start;
    let remaining = length;
    while (remaining > 0) {
      const requested = Math.min(READ_CHUNK_SIZE, remaining);
      const buffer = Buffer.allocUnsafe(requested);
      const { bytesRead } = await file.handle.read(
        buffer,
        0,
        requested,
        position,
      );
      if (bytesRead === 0) {
        throw new PanSyncError("UPLOAD_FAILED");
      }
      yield bytesRead === requested ? buffer : buffer.subarray(0, bytesRead);
      position += bytesRead;
      remaining -= bytesRead;
    }
  }
  return Readable.from(chunks());
}

async function uploadParts(
  client: AliyunAuthorizedClient,
  input: AliyunProviderUploadInput,
  upload: {
    fileId: string;
    uploadId: string;
    parts: UploadPart[];
  },
  partSize: number,
  initialAccessToken: string,
  clock: () => number,
  externalSignal?: AbortSignal,
): Promise<string> {
  let nextIndex = 0;
  let accessToken = initialAccessToken;
  let failure: PanSyncError | undefined;
  const cancellation = new AbortController();
  const abortFromExternal = (): void => cancellation.abort(externalSignal?.reason);
  if (externalSignal?.aborted === true) {
    abortFromExternal();
  } else {
    externalSignal?.addEventListener("abort", abortFromExternal, { once: true });
  }

  const stopWith = (error: unknown): void => {
    if (failure !== undefined) {
      return;
    }
    failure = error instanceof PanSyncError
      ? error
      : new PanSyncError("UPLOAD_FAILED");
    cancellation.abort();
  };

  const worker = async (): Promise<void> => {
    while (failure === undefined) {
      const index = nextIndex;
      nextIndex += 1;
      const originalPart = upload.parts[index];
      if (originalPart === undefined) {
        return;
      }

      try {
        let part = originalPart;
        if (clock() - part.acquiredAt >= UPLOAD_URL_REFRESH_AGE_MS) {
          const refreshed = await client.post(
            "/adrive/v1.0/openFile/getUploadUrl",
            accessToken,
            {
              drive_id: input.remoteDirectory.providerState.driveId,
              file_id: upload.fileId,
              upload_id: upload.uploadId,
              part_info_list: [{ part_number: part.partNumber }],
            },
            {
              failureCode: "UPLOAD_FAILED",
              signal: cancellation.signal,
            },
          );
          accessToken = refreshed.accessToken;
          part = parseRefreshedPartUrl(
            refreshed.body,
            part.partNumber,
            clock(),
          );
        }

        if (failure !== undefined) {
          return;
        }
        const start = (part.partNumber - 1) * partSize;
        const length = Math.min(partSize, input.file.size - start);
        if (length <= 0) {
          throw new PanSyncError("UPLOAD_FAILED");
        }
        const stream = rangeStream(input.file, start, length);
        await putPart(
          client,
          stream,
          part.uploadUrl,
          length,
          cancellation.signal,
        );
      } catch (error) {
        stopWith(error);
        return;
      }
    }
  };

  const workerCount = Math.min(MAX_CONCURRENT_PUTS, upload.parts.length);
  try {
    await Promise.all(Array.from({ length: workerCount }, worker));
    if (failure !== undefined) {
      throw failure;
    }
    return accessToken;
  } finally {
    externalSignal?.removeEventListener("abort", abortFromExternal);
  }
}

export async function uploadAliyunFile(
  client: AliyunAuthorizedClient,
  input: AliyunProviderUploadInput,
  clock: () => number,
  options: ProviderOperationOptions = {},
): Promise<ProviderUploadResult> {
  if (
    !Number.isSafeInteger(input.file.size)
    || input.file.size < 0
    || input.file.basename.length === 0
  ) {
    throw new PanSyncError("UPLOAD_FAILED");
  }

  const partSize = Math.max(
    MIN_PART_SIZE,
    Math.ceil(input.file.size / MAX_PARTS),
  );
  const totalParts = partCount(input.file.size, partSize);
  const create = await client.post(
    "/adrive/v1.0/openFile/create",
    input.accessToken,
    {
      drive_id: input.remoteDirectory.providerState.driveId,
      parent_file_id: input.remoteDirectory.id,
      name: input.remoteName ?? input.file.basename,
      type: "file",
      check_name_mode: "auto_rename",
      parallel_upload: true,
      size: input.file.size,
      part_info_list: Array.from(
        { length: totalParts },
        (_unused, index) => ({ part_number: index + 1 }),
      ),
    },
    {
      failureCode: "UPLOAD_FAILED",
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    },
  );
  const upload = parseCreatedUpload(create.body, totalParts, clock());
  const accessToken = await uploadParts(
    client,
    input,
    upload,
    partSize,
    create.accessToken,
    clock,
    options.signal,
  );
  const complete = await client.post(
    "/adrive/v1.0/openFile/complete",
    accessToken,
    {
      drive_id: input.remoteDirectory.providerState.driveId,
      file_id: upload.fileId,
      upload_id: upload.uploadId,
    },
    {
      failureCode: "UPLOAD_FAILED",
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    },
  );
  if (!isRecord(complete.body)) {
    throw new PanSyncError("UPLOAD_FAILED");
  }
  const remoteName =
    nonEmptyString(complete.body, "name")
    ?? nonEmptyString(complete.body, "file_name")
    ?? upload.remoteName;
  if (remoteName === undefined) {
    throw new PanSyncError("UPLOAD_FAILED");
  }
  return {
    remoteName,
    size: input.file.size,
  };
}
