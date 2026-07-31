import { randomBytes } from "node:crypto";
import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
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

export interface CredentialLeaseRunner {
  <T>(key: string, run: () => Promise<T>): Promise<T>;
}

export interface CredentialFileAdapter {
  rename(source: string, destination: string): Promise<void>;
}

const defaultFileAdapter: CredentialFileAdapter = { rename };

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

  constructor(
    private readonly dataDir: string,
    private readonly runWithLease: CredentialLeaseRunner,
    private readonly files: CredentialFileAdapter = defaultFileAdapter,
  ) {
    this.#credentialsPath = path.join(dataDir, "credentials.enc");
    this.#masterKeyPath = path.join(dataDir, "master.key");
  }

  read(): Promise<CredentialRecord | undefined> {
    return this.runWithLease(CREDENTIAL_LEASE_KEY, () => this.#readUnlocked());
  }

  replace(candidate: CredentialRecord): Promise<void> {
    return this.runWithLease(CREDENTIAL_LEASE_KEY, () => this.#writeUnlocked(candidate));
  }

  replaceIfVersion(
    expected: number,
    candidate: CredentialRecord,
  ): Promise<boolean> {
    return this.runWithLease(CREDENTIAL_LEASE_KEY, async () => {
      const current = await this.#readUnlocked();
      if (current?.credentialVersion !== expected) {
        return false;
      }

      await this.#writeUnlocked(candidate);
      return true;
    });
  }

  clear(): Promise<void> {
    return this.runWithLease(CREDENTIAL_LEASE_KEY, async () => {
      let removed = false;
      try {
        await unlink(this.#credentialsPath);
        removed = true;
      } catch (error) {
        if (!hasErrorCode(error, "ENOENT")) {
          throw error;
        }
      }

      if (removed) {
        await this.#syncDataDirectory();
      }
    });
  }

  async #readUnlocked(): Promise<CredentialRecord | undefined> {
    let serialized: string;
    try {
      serialized = await readFile(this.#credentialsPath, "utf8");
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
    let temporaryFile: Awaited<ReturnType<typeof open>> | undefined;
    let renamed = false;

    try {
      temporaryFile = await open(temporaryPath, "wx", PRIVATE_FILE_MODE);
      await temporaryFile.writeFile(`${JSON.stringify(envelope)}\n`, "utf8");
      await chmod(temporaryPath, PRIVATE_FILE_MODE);
      await temporaryFile.sync();
      await temporaryFile.close();
      temporaryFile = undefined;

      await this.files.rename(temporaryPath, this.#credentialsPath);
      renamed = true;
      await this.#syncDataDirectory();
    } finally {
      if (temporaryFile !== undefined) {
        await temporaryFile.close().catch(() => undefined);
      }
      if (!renamed) {
        await unlink(temporaryPath).catch(() => undefined);
      }
    }
  }

  async #ensureDataDirectory(): Promise<void> {
    await mkdir(this.dataDir, {
      recursive: true,
      mode: DATA_DIRECTORY_MODE,
    });
    await chmod(this.dataDir, DATA_DIRECTORY_MODE);
  }

  async #loadOrCreateMasterKey(): Promise<Buffer> {
    let keyFile: Awaited<ReturnType<typeof open>> | undefined;
    try {
      keyFile = await open(this.#masterKeyPath, "wx", PRIVATE_FILE_MODE);
    } catch (error) {
      if (hasErrorCode(error, "EEXIST")) {
        return this.#readMasterKey();
      }
      throw error;
    }

    try {
      const key = randomBytes(MASTER_KEY_BYTES);
      await keyFile.writeFile(key);
      await chmod(this.#masterKeyPath, PRIVATE_FILE_MODE);
      await keyFile.sync();
      await keyFile.close();
      keyFile = undefined;
      return key;
    } catch (error) {
      if (keyFile !== undefined) {
        await keyFile.close().catch(() => undefined);
      }
      await unlink(this.#masterKeyPath).catch(() => undefined);
      throw error;
    }
  }

  async #readMasterKey(): Promise<Buffer> {
    await chmod(this.#masterKeyPath, PRIVATE_FILE_MODE);
    const key = await readFile(this.#masterKeyPath);
    if (key.length !== MASTER_KEY_BYTES) {
      throw new Error("credential key rejected");
    }
    return key;
  }

  async #syncDataDirectory(): Promise<void> {
    if (process.platform !== "linux") {
      return;
    }

    const directory = await open(this.dataDir, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
}
