import { randomBytes } from "node:crypto";
import type { Stats } from "node:fs";
import {
  chmod as fsChmod,
  type FileHandle,
  link as fsLink,
  mkdir as fsMkdir,
  open as fsOpen,
  readFile,
  readdir as fsReaddir,
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
const INITIALIZE_FAILED = "credential store initialization failed";

function mutationAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

export type CredentialLeaseContext = {
  assertOwned(): Promise<void>;
};

export interface CredentialLeaseRunner {
  <T>(
    key: string,
    run: (lease: CredentialLeaseContext) => Promise<T>,
    options?: { signal?: AbortSignal },
  ): Promise<T>;
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
  readdir(directory: string): Promise<string[]>;
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
  readdir: fsReaddir,
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

function sameFile(left: Stats, right: Stats): boolean {
  return (
    left.isFile()
    && right.isFile()
    && left.dev === right.dev
    && left.ino === right.ino
    && (left.dev !== 0 || left.ino !== 0)
  );
}

type RollbackTransaction = {
  transactionId: string;
  markerPath: string;
  backupPath: string;
  hadCanonical: boolean;
  legacy?: boolean;
};

type RollbackMarkerV2 = {
  formatVersion: 2;
  transactionId: string;
  hadCanonical: boolean;
  backupName: string;
};

export class CredentialStore {
  readonly #credentialsPath: string;
  readonly #legacyBackupPath: string;
  readonly #masterKeyPath: string;
  readonly #legacyTransactionPath: string;
  readonly #files: CredentialFileAdapter;

  constructor(
    private readonly dataDir: string,
    private readonly runWithLease: CredentialLeaseRunner,
    files: Partial<CredentialFileAdapter> = {},
  ) {
    this.#credentialsPath = path.join(dataDir, "credentials.enc");
    this.#legacyBackupPath = path.join(dataDir, "credentials.enc.bak");
    this.#masterKeyPath = path.join(dataDir, "master.key");
    this.#legacyTransactionPath = path.join(dataDir, "credentials.txn");
    this.#files = { ...defaultFileAdapter, ...files };
  }

  async read(): Promise<CredentialRecord | undefined> {
    try {
      return await this.runWithLease(
        CREDENTIAL_LEASE_KEY,
        async (lease) => {
          await lease.assertOwned();
          const record = await this.#readUnlocked();
          await lease.assertOwned();
          return record;
        },
      );
    } catch {
      throw new Error(READ_FAILED);
    }
  }

  async replace(candidate: CredentialRecord): Promise<void> {
    try {
      await this.runWithLease(
        CREDENTIAL_LEASE_KEY,
        async (lease) => {
          await lease.assertOwned();
          await this.#writeUnlocked(candidate, undefined, lease);
        },
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
    if (mutationAborted(options.signal)) {
      return false;
    }
    const leaseController = options.signal === undefined
      ? undefined
      : new AbortController();
    const forwardAbort = (): void => leaseController?.abort();
    options.signal?.addEventListener("abort", forwardAbort, { once: true });
    if (mutationAborted(options.signal)) forwardAbort();
    const stopForwardingAbort = (): void => {
      options.signal?.removeEventListener("abort", forwardAbort);
    };
    try {
      return await this.runWithLease(CREDENTIAL_LEASE_KEY, async (lease) => {
        stopForwardingAbort();
        await lease.assertOwned();
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

        await lease.assertOwned();
        await this.#writeUnlocked(candidate, options.signal, lease);
        return true;
      }, leaseController === undefined ? {} : { signal: leaseController.signal });
    } catch {
      throw new Error(WRITE_FAILED);
    } finally {
      stopForwardingAbort();
    }
  }

  async clear(options: { signal?: AbortSignal } = {}): Promise<void> {
    if (mutationAborted(options.signal)) {
      return;
    }
    try {
      await this.runWithLease(
        CREDENTIAL_LEASE_KEY,
        async (lease) => {
          if (!mutationAborted(options.signal)) {
            await lease.assertOwned();
            await this.#clearUnlocked(options.signal, lease);
          }
        },
        options.signal === undefined ? {} : { signal: options.signal },
      );
    } catch {
      throw new Error(CLEAR_FAILED);
    }
  }

  async initialize(): Promise<void> {
    try {
      await this.runWithLease(CREDENTIAL_LEASE_KEY, async (lease) => {
        await lease.assertOwned();
        await this.#ensureDataDirectory();
        await lease.assertOwned();
      });
    } catch {
      throw new Error(INITIALIZE_FAILED);
    }
  }

  async #readUnlocked(): Promise<CredentialRecord | undefined> {
    const pendingTransactions = await this.#pendingTransactions();
    if (pendingTransactions.length > 1) {
      throw new Error("credential transaction rejected");
    }
    if (
      pendingTransactions.some((transaction) =>
        !transaction.legacy && !transaction.hadCanonical
      )
    ) {
      return undefined;
    }
    const credentialPaths = [
      ...pendingTransactions.map((transaction) => transaction.backupPath),
      this.#credentialsPath,
    ];
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
    lease?: CredentialLeaseContext,
  ): Promise<void> {
    if (mutationAborted(signal)) {
      throw new Error("credential mutation aborted");
    }
    await lease?.assertOwned();
    await this.#ensureDataDirectory();
    await lease?.assertOwned();
    await this.#recoverPendingTransactionForWrite(lease);
    await lease?.assertOwned();
    const key = await this.#loadOrCreateMasterKey();
    const envelope = encryptRecord(key, candidate);
    const transaction = this.#newTransaction();
    const temporaryPath = path.join(
      this.dataDir,
      `.credentials.enc.${randomBytes(16).toString("hex")}.tmp`,
    );
    let temporaryFile: FileHandle | undefined;
    let temporaryIdentity: Stats | undefined;
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
      temporaryIdentity = await temporaryFile.stat();
      await temporaryFile.close();
      temporaryFile = undefined;

      if (mutationAborted(signal)) {
        throw new Error("credential mutation aborted");
      }
      await lease?.assertOwned();
      await this.#prepareRollbackJournal(transaction, lease);
      await lease?.assertOwned();
      if (mutationAborted(signal)) {
        await this.#commitTransaction(transaction, lease);
        throw new Error("credential mutation aborted");
      }
      await lease?.assertOwned();
      await this.#files.rename(temporaryPath, this.#credentialsPath);
      temporaryRenamed = true;
      try {
        await this.#files.syncDirectory(this.dataDir);
      } catch (error) {
        await this.#restorePreviousCanonical(
          temporaryIdentity,
          lease,
          transaction,
        ).catch(
          () => undefined,
        );
        throw error;
      }

      await lease?.assertOwned();
      if (mutationAborted(signal)) {
        const restored = await this.#restorePreviousCanonical(
          temporaryIdentity,
          lease,
          transaction,
        );
        if (restored) await this.#commitTransaction(transaction, lease);
        throw new Error("credential mutation aborted");
      }

      await lease?.assertOwned();
      try {
        await this.#commitTransaction(transaction, lease);
      } catch (error) {
        await lease?.assertOwned();
        await this.#ensureRollbackMarker(transaction).catch(() => undefined);
        await this.#restorePreviousCanonical(
          temporaryIdentity,
          lease,
          transaction,
        ).catch(
          () => undefined,
        );
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

  #newTransaction(): RollbackTransaction {
    const transactionId = randomBytes(16).toString("hex");
    return {
      transactionId,
      markerPath: path.join(this.dataDir, `.credentials.${transactionId}.txn`),
      backupPath: path.join(
        this.dataDir,
        `.credentials.enc.${transactionId}.bak`,
      ),
      hadCanonical: false,
    };
  }

  async #pendingTransactions(): Promise<RollbackTransaction[]> {
    const transactions: RollbackTransaction[] = [];
    const names = await this.#files.readdir(this.dataDir).catch(
      (error: unknown) => {
        if (hasErrorCode(error, "ENOENT")) return [];
        throw error;
      },
    );
    const transactionBackupNames = names.filter((name) =>
      /^\.credentials\.enc\.[a-f0-9]{32}\.bak$/.test(name)
    ).sort();
    const v2Transactions: RollbackTransaction[] = [];
    for (const name of names.sort()) {
      const match = /^\.credentials\.([a-f0-9]{32})\.txn$/.exec(name);
      if (match === null) continue;
      const transactionId = match[1]!;
      const markerPath = path.join(this.dataDir, name);
      let serialized: string;
      try {
        serialized = await this.#files.readText(markerPath);
      } catch (error) {
        if (hasErrorCode(error, "ENOENT")) continue;
        throw error;
      }
      let marker: RollbackMarkerV2;
      try {
        marker = JSON.parse(serialized) as RollbackMarkerV2;
      } catch {
        throw new Error("credential transaction rejected");
      }
      const backupName = `.credentials.enc.${transactionId}.bak`;
      if (
        marker.formatVersion !== 2
        || marker.transactionId !== transactionId
        || typeof marker.hadCanonical !== "boolean"
        || marker.backupName !== backupName
      ) {
        throw new Error("credential transaction rejected");
      }
      v2Transactions.push({
        transactionId,
        markerPath,
        backupPath: path.join(this.dataDir, backupName),
        hadCanonical: marker.hadCanonical,
      });
    }

    if (v2Transactions.length > 1) {
      throw new Error("credential transaction rejected");
    }
    const v2Transaction = v2Transactions[0];
    if (v2Transaction === undefined) {
      if (transactionBackupNames.length > 0) {
        throw new Error("credential transaction rejected");
      }
    } else {
      const exactBackupName = path.basename(v2Transaction.backupPath);
      const backupClaimIsConsistent = v2Transaction.hadCanonical
        ? transactionBackupNames.length === 1
          && transactionBackupNames[0] === exactBackupName
        : transactionBackupNames.length === 0;
      if (!backupClaimIsConsistent) {
        throw new Error("credential transaction rejected");
      }
      transactions.push(v2Transaction);
    }

    try {
      await this.#files.readText(this.#legacyTransactionPath);
      transactions.push({
        transactionId: "legacy",
        markerPath: this.#legacyTransactionPath,
        backupPath: this.#legacyBackupPath,
        hadCanonical: true,
        legacy: true,
      });
    } catch (error) {
      if (!hasErrorCode(error, "ENOENT")) throw error;
    }
    return transactions;
  }

  async #prepareRollbackJournal(
    transaction: RollbackTransaction,
    lease?: CredentialLeaseContext,
  ): Promise<void> {
    transaction.hadCanonical = await this.#pathIdentity(this.#credentialsPath)
      !== undefined;
    await lease?.assertOwned();
    await this.#writeRollbackMarker(transaction);
    if (transaction.hadCanonical) {
      await lease?.assertOwned();
      await this.#files.link(this.#credentialsPath, transaction.backupPath);
    }
    await lease?.assertOwned();
    await this.#files.syncDirectory(this.dataDir);
  }

  async #writeRollbackMarker(transaction: RollbackTransaction): Promise<void> {
    let markerFile: FileHandle | undefined;
    try {
      markerFile = await this.#files.open(
        transaction.markerPath,
        "wx",
        PRIVATE_FILE_MODE,
      );
      const marker: RollbackMarkerV2 = {
        formatVersion: 2,
        transactionId: transaction.transactionId,
        hadCanonical: transaction.hadCanonical,
        backupName: path.basename(transaction.backupPath),
      };
      await markerFile.writeFile(`${JSON.stringify(marker)}\n`, "utf8");
      await this.#files.chmod(transaction.markerPath, PRIVATE_FILE_MODE);
      await markerFile.sync();
      await markerFile.close();
      markerFile = undefined;
    } finally {
      if (markerFile !== undefined) {
        await markerFile.close().catch(() => undefined);
      }
    }
  }

  async #ensureRollbackMarker(transaction: RollbackTransaction): Promise<void> {
    try {
      await this.#writeRollbackMarker(transaction);
    } catch (error) {
      if (!hasErrorCode(error, "EEXIST")) {
        throw error;
      }
    }
    await this.#files.syncDirectory(this.dataDir);
  }

  async #pathIdentity(target: string): Promise<Stats | undefined> {
    let handle: FileHandle | undefined;
    try {
      handle = await this.#files.open(target, "r");
      return await handle.stat();
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) return undefined;
      throw error;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  async #restorePreviousCanonical(
    expectedCanonical?: Stats,
    lease?: CredentialLeaseContext,
    transaction?: RollbackTransaction,
  ): Promise<boolean> {
    if (expectedCanonical !== undefined) {
      const current = await this.#pathIdentity(this.#credentialsPath);
      if (current === undefined || !sameFile(current, expectedCanonical)) {
        return false;
      }
    }
    await lease?.assertOwned();
    const backupPath = transaction?.backupPath ?? this.#legacyBackupPath;
    const hadCanonical = transaction?.hadCanonical ?? true;
    const recoveryPath = path.join(
      this.dataDir,
      `.credentials.enc.${randomBytes(16).toString("hex")}.rollback`,
    );
    let recoveryLinked = false;
    try {
      if (hadCanonical) {
        try {
          await lease?.assertOwned();
          await this.#files.link(backupPath, recoveryPath);
          recoveryLinked = true;
        } catch (error) {
          if (hasErrorCode(error, "ENOENT")) {
            throw new Error("credential transaction rejected");
          }
          throw error;
        }
        await lease?.assertOwned();
        await this.#files.rename(recoveryPath, this.#credentialsPath);
        recoveryLinked = false;
      } else {
        await lease?.assertOwned();
        await this.#files.unlink(this.#credentialsPath).catch((error: unknown) => {
          if (!hasErrorCode(error, "ENOENT")) {
            throw error;
          }
        });
      }
      await lease?.assertOwned();
      await this.#files.syncDirectory(this.dataDir);
    } finally {
      if (recoveryLinked) {
        try {
          await lease?.assertOwned();
          await this.#files.unlink(recoveryPath);
        } catch {
          // A lost owner preserves shared artifacts for the next owner.
        }
      }
    }
    return true;
  }

  async #commitTransaction(
    transaction: RollbackTransaction,
    lease?: CredentialLeaseContext,
  ): Promise<void> {
    await lease?.assertOwned();
    await this.#files.unlink(transaction.markerPath);
    await this.#files.syncDirectory(this.dataDir);
    if (transaction.hadCanonical) {
      await lease?.assertOwned();
      await this.#files.unlink(transaction.backupPath).catch((error: unknown) => {
        if (!hasErrorCode(error, "ENOENT")) {
          throw error;
        }
      });
      await this.#files.syncDirectory(this.dataDir).catch(() => undefined);
    }
  }

  async #recoverPendingTransactionForWrite(
    lease?: CredentialLeaseContext,
  ): Promise<void> {
    const transactions = await this.#pendingTransactions();
    if (transactions.length > 1) {
      throw new Error("credential transaction rejected");
    }
    const transaction = transactions[0];
    if (transaction === undefined) return;

    await this.#restorePreviousCanonical(undefined, lease, transaction);
    await lease?.assertOwned();
    await this.#files.unlink(transaction.markerPath);
    await this.#files.syncDirectory(this.dataDir);
    if (transaction.hadCanonical) {
      await lease?.assertOwned();
      await this.#files.unlink(transaction.backupPath);
      await this.#files.syncDirectory(this.dataDir).catch(() => undefined);
    }
  }

  async #clearUnlocked(
    signal?: AbortSignal,
    lease?: CredentialLeaseContext,
  ): Promise<void> {
    if (mutationAborted(signal)) {
      throw new Error("credential mutation aborted");
    }
    await lease?.assertOwned();
    await this.#recoverPendingTransactionForWrite(lease);
    await lease?.assertOwned();
    const transaction = this.#newTransaction();
    await this.#prepareRollbackJournal(transaction, lease);
    await lease?.assertOwned();
    if (mutationAborted(signal)) {
      await this.#commitTransaction(transaction, lease);
      throw new Error("credential mutation aborted");
    }
    if (!transaction.hadCanonical) {
      await this.#commitTransaction(transaction, lease);
      return;
    }

    await lease?.assertOwned();
    await this.#files.unlink(this.#credentialsPath);
    await lease?.assertOwned();
    if (mutationAborted(signal)) {
      const restored = await this.#restorePreviousCanonical(
        undefined,
        lease,
        transaction,
      );
      if (restored) await this.#commitTransaction(transaction, lease);
      throw new Error("credential mutation aborted");
    }
    try {
      await lease?.assertOwned();
      await this.#files.syncDirectory(this.dataDir);
    } catch (error) {
      await lease?.assertOwned();
      const restored = await this.#restorePreviousCanonical(
        undefined,
        lease,
        transaction,
      );
      if (restored) await this.#commitTransaction(transaction, lease);
      throw error;
    }
    await lease?.assertOwned();
    if (mutationAborted(signal)) {
      const restored = await this.#restorePreviousCanonical(
        undefined,
        lease,
        transaction,
      );
      if (restored) await this.#commitTransaction(transaction, lease);
      throw new Error("credential mutation aborted");
    }
    await this.#commitTransaction(transaction, lease);
  }
}
