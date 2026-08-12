import chalk from 'chalk';

import {
  findClaudeCodeInstallation,
  getPendingCandidates,
} from './installationDetection';
import { doesFileExist } from './utils';
import {
  CLIJS_BACKUP_FILE,
  NATIVE_BINARY_BACKUP_FILE,
  readConfigFile,
} from './config';
import { debug } from './utils';
import { displaySyncResults, syncSystemPrompts } from './systemPromptSync';
import {
  ClaudeCodeInstallationInfo,
  FindInstallationOptions,
  InstallationCandidate,
  StartupCheckInfo,
  TweakccConfig,
} from './types';
import {
  backupClijs,
  backupNativeBinary,
  NonPristineBackupError,
} from './installationBackup';

/**
 * Run a backup, surfacing a refusal instead of aborting startup.
 *
 * A refusal means the installed Claude Code is already patched, so there is
 * nothing pristine to capture. That is worth shouting about — without a
 * pristine backup `--restore` cannot undo anything — but it must not take the
 * whole tool down, and it must leave whatever backup already exists untouched.
 *
 * @returns whether a backup was actually written
 */
async function backupOrWarn(backup: () => Promise<void>): Promise<boolean> {
  try {
    await backup();
    return true;
  } catch (error) {
    if (!(error instanceof NonPristineBackupError)) throw error;
    console.log(chalk.yellow(error.message));
    return false;
  }
}

export interface StartupCheckResult {
  startupCheckInfo: StartupCheckInfo | null;
  pendingCandidates: InstallationCandidate[] | null;
  config: TweakccConfig;
}

/**
 * Performs startup checking: finding Claude Code, creating a backup if necessary, checking if
 * it's been updated.
 *
 * @param options - Options for installation detection (interactive mode flag)
 * @param providedConfig - Optional pre-loaded config (e.g., from URL). If not provided, reads from local file.
 * @returns StartupCheckResult with either startupCheckInfo or pendingCandidates for UI selection
 */
export async function startupCheck(
  options: FindInstallationOptions,
  providedConfig?: TweakccConfig
): Promise<StartupCheckResult> {
  const config = providedConfig ?? (await readConfigFile());

  const ccInstInfo = await findClaudeCodeInstallation(config, options);
  if (!ccInstInfo) {
    return { startupCheckInfo: null, pendingCandidates: null, config };
  }

  const pendingCandidates = getPendingCandidates(ccInstInfo);
  if (pendingCandidates) {
    return { startupCheckInfo: null, pendingCandidates, config };
  }

  return {
    startupCheckInfo: await completeStartupCheck(config, ccInstInfo),
    pendingCandidates: null,
    config,
  };
}

/**
 * Completes the startup check after installation is resolved.
 * Called directly when no selection needed, or after user selects an installation.
 */
export async function completeStartupCheck(
  config: TweakccConfig,
  ccInstInfo: ClaudeCodeInstallationInfo
): Promise<StartupCheckInfo | null> {
  if (!ccInstInfo) {
    return null;
  }

  // Sync system prompts with the current CC version
  if (ccInstInfo.version) {
    try {
      const syncSummary = await syncSystemPrompts(ccInstInfo.version);
      displaySyncResults(syncSummary);
    } catch {
      // Error already logged with chalk.red in syncSystemPrompts
      // Continue with startup check even if prompt sync fails
    }
  }

  const realVersion = ccInstInfo.version;
  const backedUpVersion = config.ccVersion;

  // Backup cli.js if we don't have any backup yet.
  let hasBackedUp = false;
  if (!(await doesFileExist(CLIJS_BACKUP_FILE))) {
    debug(`startupCheck: ${CLIJS_BACKUP_FILE} not found; backing up cli.js`);
    hasBackedUp = await backupOrWarn(() => backupClijs(ccInstInfo));
  }

  // Backup native binary if we don't have any backup yet (for native installations)
  let hasBackedUpNativeBinary = false;
  if (
    ccInstInfo.nativeInstallationPath &&
    !(await doesFileExist(NATIVE_BINARY_BACKUP_FILE))
  ) {
    debug(
      `startupCheck: ${NATIVE_BINARY_BACKUP_FILE} not found; backing up native binary`
    );
    hasBackedUpNativeBinary = await backupOrWarn(() =>
      backupNativeBinary(ccInstInfo)
    );
  }

  // If the installed CC version is different from what we have backed up, take
  // a fresh backup of the new version.
  //
  // The old backup is NOT unlinked first. `backupClijs`/`backupNativeBinary`
  // copy to a sibling temp and rename onto the destination, so the replacement
  // is atomic and the previous backup survives intact if anything goes wrong —
  // including the pristine guard refusing an already-patched source. Unlinking
  // up front destroyed the only pristine copy before we knew whether a valid
  // replacement could even be written.
  if (realVersion !== backedUpVersion) {
    // The version we have backed up is different than what's installed.  Mostly likely the user
    // updated CC, so we should back up the new version.  If the backup didn't even exist until we
    // copied in there above, though, we shouldn't back it up twice.
    if (!hasBackedUp) {
      debug(
        `startupCheck: real version (${realVersion}) != backed up version (${backedUpVersion}); backing up cli.js`
      );
      await backupOrWarn(() => backupClijs(ccInstInfo));
    }

    // Also backup native binary if version changed
    if (ccInstInfo.nativeInstallationPath && !hasBackedUpNativeBinary) {
      debug(
        `startupCheck: real version (${realVersion}) != backed up version (${backedUpVersion}); backing up native binary`
      );
      await backupOrWarn(() => backupNativeBinary(ccInstInfo));
    }

    return {
      wasUpdated: true,
      oldVersion: backedUpVersion,
      newVersion: realVersion,
      ccInstInfo,
    };
  }

  return {
    wasUpdated: false,
    oldVersion: null,
    newVersion: null,
    ccInstInfo,
  };
}
