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
const READ_FAILED = "credential store read failed";
const WRITE_FAILED = "credential store write failed";
const CLEAR_FAILED = "credential store clear failed";

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
  readonly #masterKeyPath: string;
  readonly #files: CredentialFileAdapter;

  constructor(
    private readonly dataDir: string,
    private readonly runWithLease: CredentialLeaseRunner,
    files: Partial<CredentialFileAdapter> = {},
  ) {
    this.#credentialsPath = path.join(dataDir, "credentials.enc");
    this.#masterKeyPath = path.join(dataDir, "master.key");
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
    expected: number,
    candidate: CredentialRecord,
  ): Promise<boolean> {
    try {
      return await this.runWithLease(CREDENTIAL_LEASE_KEY, async () => {
        const current = await this.#readUnlocked();
        if (current?.credentialVersion !== expected) {
          return false;
        }

        await this.#writeUnlocked(candidate);
        return true;
      });
    } catch {
      throw new Error(WRITE_FAILED);
    }
  }

  async clear(): Promise<void> {
    try {
      await this.runWithLease(
        CREDENTIAL_LEASE_KEY,
        () => this.#clearUnlocked(),
      );
    } catch {
      throw new Error(CLEAR_FAILED);
    }
  }

  async #readUnlocked(): Promise<CredentialRecord | undefined> {
    let serialized: string;
    try {
      serialized = await this.#files.readText(this.#credentialsPath);
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) {
        return undefined;
      }
      throw error;
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

  async #writeUnlocked(candidate: CredentialRecord): Promise<void> {
    await this.#ensureDataDirectory();
    const key = await this.#loadOrCreateMasterKey();
    const envelope = encryptRecord(key, candidate);
    const temporaryPath = path.join(
      this.dataDir,
      `.credentials.enc.${randomBytes(16).toString("hex")}.tmp`,
    );
    const backupPath = path.join(
      this.dataDir,
      `.credentials.enc.${randomBytes(16).toString("hex")}.bak`,
    );
    let temporaryFile: FileHandle | undefined;
    let temporaryRenamed = false;
    let backupCreated = false;
    let preserveBackup = false;

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

      try {
        await this.#files.link(this.#credentialsPath, backupPath);
        backupCreated = true;
        await this.#files.syncDirectory(this.dataDir);
      } catch (error) {
        if (!hasErrorCode(error, "ENOENT")) {
          throw error;
        }
      }

      await this.#files.rename(temporaryPath, this.#credentialsPath);
      temporaryRenamed = true;
      try {
        await this.#files.syncDirectory(this.dataDir);
      } catch (error) {
        preserveBackup = backupCreated;
        if (backupCreated) {
          await this.#files.rename(backupPath, this.#credentialsPath);
          backupCreated = false;
        } else {
          await this.#files.unlink(this.#credentialsPath);
        }
        await this.#files.syncDirectory(this.dataDir);
        throw error;
      }

      if (backupCreated) {
        await this.#files.unlink(backupPath).catch(() => undefined);
        backupCreated = false;
      }
    } finally {
      if (temporaryFile !== undefined) {
        await temporaryFile.close().catch(() => undefined);
      }
      if (!temporaryRenamed) {
        await this.#files.unlink(temporaryPath).catch(() => undefined);
      }
      if (backupCreated && !preserveBackup) {
        await this.#files.unlink(backupPath).catch(() => undefined);
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

  async #clearUnlocked(): Promise<void> {
    const backupPath = path.join(
      this.dataDir,
      `.credentials.enc.${randomBytes(16).toString("hex")}.bak`,
    );
    let backupCreated = false;
    let preserveBackup = false;
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
      await this.#files.unlink(this.#credentialsPath);
      try {
        await this.#files.syncDirectory(this.dataDir);
      } catch (error) {
        preserveBackup = true;
        await this.#files.rename(backupPath, this.#credentialsPath);
        backupCreated = false;
        await this.#files.syncDirectory(this.dataDir);
        throw error;
      }

      await this.#files.unlink(backupPath).catch(() => undefined);
      backupCreated = false;
    } finally {
      if (backupCreated && !preserveBackup) {
        await this.#files.unlink(backupPath).catch(() => undefined);
      }
    }
  }
}
