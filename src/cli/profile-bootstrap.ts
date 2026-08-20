import { mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { AgentPreflightError, type LocalAgentId } from '../agent/preflight';
import {
  createDefaultProfileConfig,
  type AgentKind,
  type ProfileConfig,
} from '../config/profile-schema';
import type { AppConfig } from '../config/schema';
import { resolveWorkingDirectory } from '../policy/workspace';
import { resolveExecutablePath } from './agent-detection';

export interface BootstrapProfileInput {
  agentKind: AgentKind;
  accounts: AppConfig['accounts'];
  preferences?: AppConfig['preferences'];
  secrets?: AppConfig['secrets'];
  workspace?: string;
  defaultWorkspace?: string;
  codexBinaryPath?: string;
  profileDir?: string;
}

export async function createBootstrapProfileConfig(
  input: BootstrapProfileInput,
): Promise<ProfileConfig> {
  const workspace = input.workspace
    ? await resolveBootstrapWorkspace(input.workspace)
    : input.defaultWorkspace
      ? await ensureManagedDefaultWorkspace(input.defaultWorkspace)
      : undefined;
  const codex =
    input.agentKind === 'codex' || input.agentKind === 'trae'
      ? await createBootstrapCodexConfig(input.codexBinaryPath, input.agentKind)
      : undefined;
  const profile = createDefaultProfileConfig({
    agentKind: input.agentKind,
    accounts: input.accounts,
    preferences: input.preferences,
    secrets: input.secrets,
    ...(codex ? { codex } : {}),
  });
  if (workspace) {
    profile.workspaces = {
      ...profile.workspaces,
      default: workspace,
    };
  }
  if (input.profileDir && profile.codex?.inheritCodexHome === false) {
    await mkdir(join(input.profileDir, 'codex-home'), { recursive: true });
  }
  return profile;
}

export async function resolveBootstrapWorkspace(workspace: string): Promise<string> {
  const resolved = await resolveWorkingDirectory(workspace);
  if (!resolved.ok) throw new Error(resolved.userVisible);
  return resolved.cwdRealpath;
}

async function ensureManagedDefaultWorkspace(path: string): Promise<string> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  return realpath(path);
}

/**
 * Per-agent binary discovery descriptor for the Codex-family kinds. TRAE CLI
 * (`traex`) is a Codex fork sharing the same CodexConfig shape, so both flow
 * through the same bootstrap path and only differ by default command, env
 * override, and diagnostic identity.
 */
interface CodexFamilyBinaryDescriptor {
  agentId: LocalAgentId;
  agentName: string;
  defaultCommand: string;
  envVar: string;
}

const CODEX_FAMILY_BINARIES: Record<'codex' | 'trae', CodexFamilyBinaryDescriptor> = {
  codex: {
    agentId: 'codex',
    agentName: 'Codex CLI',
    defaultCommand: 'codex',
    envVar: 'LARK_CHANNEL_CODEX_BIN',
  },
  trae: {
    agentId: 'trae',
    agentName: 'TRAE CLI',
    defaultCommand: 'traex',
    envVar: 'LARK_CHANNEL_TRAE_BIN',
  },
};

export async function createBootstrapCodexConfig(
  binaryPath: string | undefined,
  agentKind: 'codex' | 'trae' = 'codex',
) {
  const descriptor = CODEX_FAMILY_BINARIES[agentKind];
  const command = binaryPath ?? process.env[descriptor.envVar] ?? descriptor.defaultCommand;
  let resolvedBinary: string;
  try {
    resolvedBinary = await resolveExecutablePath(command);
  } catch (err) {
    const errno = (err as NodeJS.ErrnoException).code;
    throw new AgentPreflightError({
      code: codexBootstrapBinaryErrorCode(errno),
      agentId: descriptor.agentId,
      agentName: descriptor.agentName,
      command,
      binaryPath: command,
      errno,
    });
  }
  return { binaryPath: resolvedBinary };
}

function codexBootstrapBinaryErrorCode(errno: string | undefined) {
  if (errno === 'EACCES' || errno === 'EPERM') return 'agent-binary-not-executable';
  if (errno === 'ELOOP' || errno === 'ENOTDIR' || errno === 'EINVAL') {
    return 'agent-binary-resolve-failed';
  }
  return 'agent-binary-not-found';
}
