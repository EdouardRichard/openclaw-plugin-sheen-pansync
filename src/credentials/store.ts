import { randomBytes } from "node:crypto";
import {
  chmod as fsChmod,
  type FileHandle,
  link as fsLink,
  mkdir as fsMkdir,
  open as fsOpen,
  readFile,
  rename as fsRename,
  unlink as fsUnlink,
} from "node:fs/promises";
import path from "node:path";
import { decryptRecord, encryptRecord } from "./crypto.js";
import type {
  CredentialRecord,
  EncryptedEnvelopeV1,
} from "./types.js";

const CREDENTIAL_LEASE_KEY = "credentials";
const DATA_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const MASTER_KEY_BYTES = 32;
const ROLLBACK_MARKER = "rollback-v1\n";
const READ_FAILED = "credential store read failed";
const WRITE_FAILED = "credential store write failed";
const CLEAR_FAILED = "credential store clear failed";

function mutationAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

export interface CredentialLeaseRunner {
  <T>(key: string, run: () => Promise<T>): Promise<T>;
}

export interface CredentialFileAdapter {
  chmod(target: string, mode: number): Promise<void>;
  link(existingPath: string, newPath: string): Promise<void>;
  mkdir(
    directory: string,
    options: { recursive: true; mode: number },
  ): Promise<void>;
  open(target: string, flags: string, mode?: number): Promise<FileHandle>;
  readBuffer(target: string): Promise<Buffer>;
  readText(target: string): Promise<string>;
  rename(source: string, destination: string): Promise<void>;
  unlink(target: string): Promise<void>;
  syncDirectory(directory: string): Promise<void>;
}

const defaultFileAdapter: CredentialFileAdapter = {
  chmod: fsChmod,
  link: fsLink,
  async mkdir(directory, options) {
    await fsMkdir(directory, options);
  },
  open: fsOpen,
  readBuffer: (target) => readFile(target),
  readText: (target) => readFile(target, "utf8"),
  rename: fsRename,
  unlink: fsUnlink,
  async syncDirectory(directory) {
    if (process.platform !== "linux") {
      return;
    }

    const handle = await fsOpen(directory, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
};

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === code
  );
}

export class CredentialStore {
  readonly #credentialsPath: string;
  readonly #backupPath: string;
  readonly #masterKeyPath: string;
  readonly #transactionPath: string;
  readonly #files: CredentialFileAdapter;

  constructor(
    private readonly dataDir: string,
    private readonly runWithLease: CredentialLeaseRunner,
    files: Partial<CredentialFileAdapter> = {},
  ) {
    this.#credentialsPath = path.join(dataDir, "credentials.enc");
    this.#backupPath = path.join(dataDir, "credentials.enc.bak");
    this.#masterKeyPath = path.join(dataDir, "master.key");
    this.#transactionPath = path.join(dataDir, "credentials.txn");
    this.#files = { ...defaultFileAdapter, ...files };
  }

  async read(): Promise<CredentialRecord | undefined> {
    try {
      return await this.runWithLease(
        CREDENTIAL_LEASE_KEY,
        () => this.#readUnlocked(),
      );
    } catch {
      throw new Error(READ_FAILED);
    }
  }

  async replace(candidate: CredentialRecord): Promise<void> {
    try {
      await this.runWithLease(
        CREDENTIAL_LEASE_KEY,
        () => this.#writeUnlocked(candidate),
      );
    } catch {
      throw new Error(WRITE_FAILED);
    }
  }

  async replaceIfVersion(
    expected: number | undefined,
    candidate: CredentialRecord,
    options: { signal?: AbortSignal } = {},
  ): Promise<boolean> {
    try {
      return await this.runWithLease(CREDENTIAL_LEASE_KEY, async () => {
        if (mutationAborted(options.signal)) {
          return false;
        }
        const current = await this.#readUnlocked();
        if (
          mutationAborted(options.signal)
          || current?.credentialVersion !== expected
        ) {
          return false;
        }

        await this.#writeUnlocked(candidate, options.signal);
        return true;
      });
    } catch {
      throw new Error(WRITE_FAILED);
    }
  }

  async clear(options: { signal?: AbortSignal } = {}): Promise<void> {
    try {
      await this.runWithLease(
        CREDENTIAL_LEASE_KEY,
        async () => {
          if (!mutationAborted(options.signal)) {
            await this.#clearUnlocked(options.signal);
          }
        },
      );
    } catch {
      throw new Error(CLEAR_FAILED);
    }
  }

  async #readUnlocked(): Promise<CredentialRecord | undefined> {
    const credentialPaths = await this.#hasPendingTransaction()
      ? [this.#backupPath, this.#credentialsPath]
      : [this.#credentialsPath];
    let serialized: string | undefined;
    for (const credentialsPath of credentialPaths) {
      try {
        serialized = await this.#files.readText(credentialsPath);
        break;
      } catch (error) {
        if (!hasErrorCode(error, "ENOENT")) {
          throw error;
        }
      }
    }
    if (serialized === undefined) {
      return undefined;
    }

    let envelope: EncryptedEnvelopeV1;
    try {
      envelope = JSON.parse(serialized) as EncryptedEnvelopeV1;
    } catch {
      throw new Error("credential ciphertext rejected");
    }

    const key = await this.#readMasterKey();
    return decryptRecord<CredentialRecord>(key, envelope);
  }

  async #writeUnlocked(
    candidate: CredentialRecord,
    signal?: AbortSignal,
  ): Promise<void> {
    if (mutationAborted(signal)) {
      throw new Error("credential mutation aborted");
    }
    await this.#ensureDataDirectory();
    await this.#recoverPendingTransactionForWrite();
    const key = await this.#loadOrCreateMasterKey();
    const envelope = encryptRecord(key, candidate);
    const temporaryPath = path.join(
      this.dataDir,
      `.credentials.enc.${randomBytes(16).toString("hex")}.tmp`,
    );
    let temporaryFile: FileHandle | undefined;
    let temporaryRenamed = false;

    try {
      temporaryFile = await this.#files.open(
        temporaryPath,
        "wx",
        PRIVATE_FILE_MODE,
      );
      await temporaryFile.writeFile(`${JSON.stringify(envelope)}\n`, "utf8");
      await this.#files.chmod(temporaryPath, PRIVATE_FILE_MODE);
      await temporaryFile.sync();
      await temporaryFile.close();
      temporaryFile = undefined;

      if (mutationAborted(signal)) {
        throw new Error("credential mutation aborted");
      }
      await this.#prepareRollbackJournal();
      if (mutationAborted(signal)) {
        await this.#commitTransaction();
        throw new Error("credential mutation aborted");
      }
      await this.#files.rename(temporaryPath, this.#credentialsPath);
      temporaryRenamed = true;
      try {
        await this.#files.syncDirectory(this.dataDir);
      } catch (error) {
        await this.#restorePreviousCanonical().catch(() => undefined);
        throw error;
      }

      if (mutationAborted(signal)) {
        await this.#restorePreviousCanonical();
        await this.#commitTransaction();
        throw new Error("credential mutation aborted");
      }

      try {
        await this.#commitTransaction();
      } catch (error) {
        await this.#ensureRollbackMarker().catch(() => undefined);
        await this.#restorePreviousCanonical().catch(() => undefined);
        throw error;
      }
    } finally {
      if (temporaryFile !== undefined) {
        await temporaryFile.close().catch(() => undefined);
      }
      if (!temporaryRenamed) {
        await this.#files.unlink(temporaryPath).catch(() => undefined);
      }
    }
  }

  async #ensureDataDirectory(): Promise<void> {
    await this.#files.mkdir(this.dataDir, {
      recursive: true,
      mode: DATA_DIRECTORY_MODE,
    });
    await this.#files.chmod(this.dataDir, DATA_DIRECTORY_MODE);
  }

  async #loadOrCreateMasterKey(): Promise<Buffer> {
    let keyFile: FileHandle | undefined;
    try {
      keyFile = await this.#files.open(
        this.#masterKeyPath,
        "wx",
        PRIVATE_FILE_MODE,
      );
    } catch (error) {
      if (hasErrorCode(error, "EEXIST")) {
        await this.#files.chmod(this.#masterKeyPath, PRIVATE_FILE_MODE);
        return this.#readMasterKey();
      }
      throw error;
    }

    try {
      const key = randomBytes(MASTER_KEY_BYTES);
      await keyFile.writeFile(key);
      await this.#files.chmod(this.#masterKeyPath, PRIVATE_FILE_MODE);
      await keyFile.sync();
      await keyFile.close();
      keyFile = undefined;
      return key;
    } catch (error) {
      if (keyFile !== undefined) {
        await keyFile.close().catch(() => undefined);
      }
      await this.#files.unlink(this.#masterKeyPath).catch(() => undefined);
      throw error;
    }
  }

  async #readMasterKey(): Promise<Buffer> {
    const key = await this.#files.readBuffer(this.#masterKeyPath);
    if (key.length !== MASTER_KEY_BYTES) {
      throw new Error("credential key rejected");
    }
    return key;
  }

  async #hasPendingTransaction(): Promise<boolean> {
    try {
      await this.#files.readText(this.#transactionPath);
      return true;
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) {
        return false;
      }
      throw error;
    }
  }

  async #prepareRollbackJournal(): Promise<void> {
    await this.#files.unlink(this.#backupPath).catch((error: unknown) => {
      if (!hasErrorCode(error, "ENOENT")) {
        throw error;
      }
    });
    try {
      await this.#files.link(this.#credentialsPath, this.#backupPath);
    } catch (error) {
      if (!hasErrorCode(error, "ENOENT")) {
        throw error;
      }
    }

    await this.#writeRollbackMarker();
    await this.#files.syncDirectory(this.dataDir);
  }

  async #writeRollbackMarker(): Promise<void> {
    let markerFile: FileHandle | undefined;
    try {
      markerFile = await this.#files.open(
        this.#transactionPath,
        "wx",
        PRIVATE_FILE_MODE,
      );
      await markerFile.writeFile(ROLLBACK_MARKER, "utf8");
      await this.#files.chmod(this.#transactionPath, PRIVATE_FILE_MODE);
      await markerFile.sync();
      await markerFile.close();
      markerFile = undefined;
    } finally {
      if (markerFile !== undefined) {
        await markerFile.close().catch(() => undefined);
      }
    }
  }

  async #ensureRollbackMarker(): Promise<void> {
    try {
      await this.#writeRollbackMarker();
    } catch (error) {
      if (!hasErrorCode(error, "EEXIST")) {
        throw error;
      }
    }
    await this.#files.syncDirectory(this.dataDir);
  }

  async #restorePreviousCanonical(): Promise<void> {
    const recoveryPath = path.join(
      this.dataDir,
      `.credentials.enc.${randomBytes(16).toString("hex")}.rollback`,
    );
    let recoveryLinked = false;
    try {
      try {
        await this.#files.link(this.#backupPath, recoveryPath);
        recoveryLinked = true;
      } catch (error) {
        if (!hasErrorCode(error, "ENOENT")) {
          throw error;
        }
      }

      if (recoveryLinked) {
        await this.#files.rename(recoveryPath, this.#credentialsPath);
        recoveryLinked = false;
      } else {
        await this.#files.unlink(this.#credentialsPath).catch((error: unknown) => {
          if (!hasErrorCode(error, "ENOENT")) {
            throw error;
          }
        });
      }
      await this.#files.syncDirectory(this.dataDir);
    } finally {
      if (recoveryLinked) {
        await this.#files.unlink(recoveryPath).catch(() => undefined);
      }
    }
  }

  async #commitTransaction(): Promise<void> {
    await this.#files.unlink(this.#transactionPath);
    await this.#files.syncDirectory(this.dataDir);
    await this.#files.unlink(this.#backupPath).catch((error: unknown) => {
      if (!hasErrorCode(error, "ENOENT")) {
        throw error;
      }
    });
    await this.#files.syncDirectory(this.dataDir).catch(() => undefined);
  }

  async #recoverPendingTransactionForWrite(): Promise<void> {
    if (!(await this.#hasPendingTransaction())) {
      await this.#files.unlink(this.#backupPath).catch((error: unknown) => {
        if (!hasErrorCode(error, "ENOENT")) {
          throw error;
        }
      });
      return;
    }

    await this.#restorePreviousCanonical();
    await this.#files.unlink(this.#transactionPath);
    await this.#files.syncDirectory(this.dataDir);
    await this.#files.unlink(this.#backupPath).catch(() => undefined);
    await this.#files.syncDirectory(this.dataDir).catch(() => undefined);
  }

  async #clearUnlocked(signal?: AbortSignal): Promise<void> {
    if (mutationAborted(signal)) {
      throw new Error("credential mutation aborted");
    }
    await this.#recoverPendingTransactionForWrite();
    const backupPath = path.join(
      this.dataDir,
      `.credentials.enc.${randomBytes(16).toString("hex")}.bak`,
    );
    let backupCreated = false;
    let preserveBackup = false;
    let canonicalDeleted = false;
    const restoreCanonical = async (): Promise<void> => {
      if (!canonicalDeleted) {
        return;
      }
      preserveBackup = true;
      await this.#files.link(backupPath, this.#credentialsPath);
      canonicalDeleted = false;
      await this.#files.syncDirectory(this.dataDir);
      preserveBackup = false;
    };
    try {
      try {
        await this.#files.link(this.#credentialsPath, backupPath);
        backupCreated = true;
      } catch (error) {
        if (hasErrorCode(error, "ENOENT")) {
          return;
        }
        throw error;
      }

      await this.#files.syncDirectory(this.dataDir);
      if (mutationAborted(signal)) {
        throw new Error("credential mutation aborted");
      }
      await this.#files.unlink(this.#credentialsPath);
      canonicalDeleted = true;
      if (mutationAborted(signal)) {
        await restoreCanonical();
        throw new Error("credential mutation aborted");
      }
      try {
        await this.#files.syncDirectory(this.dataDir);
      } catch (error) {
        await restoreCanonical();
        throw error;
      }
      if (mutationAborted(signal)) {
        await restoreCanonical();
        throw new Error("credential mutation aborted");
      }

      try {
        await this.#files.unlink(backupPath);
      } catch (error) {
        await restoreCanonical();
        throw error;
      }
      backupCreated = false;
      await this.#files.syncDirectory(this.dataDir).catch(() => undefined);
    } finally {
      if (backupCreated && !preserveBackup) {
        await this.#files.unlink(backupPath).catch(() => undefined);
      }
    }
  }
}
