import type { AccessMode } from '../config/permissions';
import type { ProfileConfig } from '../config/profile-schema';
import { BRIDGE_SYSTEM_PROMPT } from './bridge-system-prompt';

export type AgentCapabilityId = 'claude' | 'codex' | 'trae';
export type AgentSessionKind = 'claude-session' | 'codex-thread';
export type PromptInjectionMode = 'append-system-prompt' | 'stdin-prefix';

export interface AgentCapability {
  agentId: AgentCapabilityId;
  sessionKind: AgentSessionKind;
  promptInjection: PromptInjectionMode;
  systemPrompt: string;
  supportsNativeHistory: boolean;
  callback: {
    marker: '__bridge_cb';
    legacyMarkers: string[];
  };
  permissions: {
    maxAccess: AccessMode;
  };
}

export function claudeCapability(profile?: Pick<ProfileConfig, 'permissions'>): AgentCapability {
  const maxAccess = profile?.permissions.maxAccess ?? 'full';
  return {
    agentId: 'claude',
    sessionKind: 'claude-session',
    promptInjection: 'append-system-prompt',
    systemPrompt: BRIDGE_SYSTEM_PROMPT,
    supportsNativeHistory: true,
    callback: {
      marker: '__bridge_cb',
      legacyMarkers: ['__claude_cb'],
    },
    permissions: {
      maxAccess,
    },
  };
}

export function codexCapability(profile: Pick<ProfileConfig, 'permissions'>): AgentCapability {
  const maxAccess = profile.permissions.maxAccess;
  return {
    agentId: 'codex',
    sessionKind: 'codex-thread',
    promptInjection: 'stdin-prefix',
    systemPrompt: BRIDGE_SYSTEM_PROMPT,
    supportsNativeHistory: false,
    callback: {
      marker: '__bridge_cb',
      legacyMarkers: [],
    },
    permissions: {
      maxAccess,
    },
  };
}

/**
 * TRAE CLI (`traex`) capability. TRAE is a Codex fork, so it shares Codex's
 * thread-based session model, stdin-prefix prompt injection, and lack of
 * native history — the only difference from {@link codexCapability} is the
 * `agentId` tag, which keeps session-catalog entries labeled `'trae'` (rather
 * than being silently recorded as codex) while still flowing through the
 * codex-family runtime guards via `isCodexFamily`.
 */
export function traeCapability(profile: Pick<ProfileConfig, 'permissions'>): AgentCapability {
  return {
    ...codexCapability(profile),
    agentId: 'trae',
  };
}

/**
 * Resolve the capability for a profile's configured agent. Central dispatcher
 * so call sites don't repeat the `agentKind` ternary and every kind — including
 * `'trae'` — is routed to its own capability (never silently downgraded to
 * claude or relabeled as codex).
 */
export function agentCapability(
  profile: Pick<ProfileConfig, 'permissions'> & { agentKind: ProfileConfig['agentKind'] },
): AgentCapability {
  if (profile.agentKind === 'codex') return codexCapability(profile);
  if (profile.agentKind === 'trae') return traeCapability(profile);
  return claudeCapability(profile);
}
