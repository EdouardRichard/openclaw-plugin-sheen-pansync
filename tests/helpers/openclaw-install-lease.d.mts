export function openClawInstallLockDirectory(parentPid?: number): string;

export function withOpenClawInstallLease<T>(
  run: () => T | Promise<T>,
): Promise<T>;
