import type { AgentKind } from '../config/profile-schema';
import { spawnProcess } from '../platform/spawn';
import { log } from '../core/logger';

/**
 * Sentinel selection meaning "don't pass `--model`; let the agent CLI /
 * account decide". Kept as a real option value (rather than empty string)
 * because Feishu's `select_static` requires `initial_option` to match one of
 * the option `value`s exactly and rejects an empty string.
 */
export const DEFAULT_MODEL = 'default';

export interface ModelOption {
  /**
   * Stored in `preferences.model` and forwarded to the agent's `--model`
   * flag. `DEFAULT_MODEL` is special-cased to omit the flag entirely.
   */
  value: string;
  /** Human-facing label shown in the `/config` picker. */
  label: string;
}

/**
 * Claude Code models. Pinned to concrete version ids (Claude Code's `--model`
 * accepts the full model-id string, not just the `opus`/`sonnet` aliases) so
 * the picker names an exact model. Add new ids here when a generation ships;
 * `opusplan` is kept as the one alias with no versioned equivalent (it runs
 * Opus for planning and Sonnet for execution).
 */
const CLAUDE_MODELS: ModelOption[] = [
  { value: DEFAULT_MODEL, label: '跟随默认（不指定）' },
  { value: 'claude-opus-4-8', label: 'Opus 4.8（最新）' },
  { value: 'claude-opus-4-7', label: 'Opus 4.7' },
  { value: 'claude-sonnet-5', label: 'Sonnet 5（最新）' },
  { value: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
  { value: 'claude-haiku-4-5', label: 'Haiku 4.5（最新）' },
  { value: 'opusplan', label: 'Opus Plan（规划用 Opus，执行用 Sonnet）' },
];

/** Codex CLI models. Forwarded to `codex exec --model`. */
const CODEX_MODELS: ModelOption[] = [
  { value: DEFAULT_MODEL, label: '跟随默认（不指定）' },
  { value: 'gpt-5-codex', label: 'GPT-5 Codex' },
  { value: 'gpt-5', label: 'GPT-5' },
  { value: 'o3', label: 'o3' },
];

/**
 * TRAE CLI (`traex`) models. The real catalog is account-specific — internal
 * and external accounts expose different model ids — so it's discovered at
 * runtime by {@link refreshTraeModels} (which runs `traex models` at startup).
 * This hardcoded list is only the fallback used before / if that probe runs,
 * and is intentionally kept to just the "follow default" sentinel so no
 * account's private model ids are baked into the published source.
 */
const TRAE_MODELS: ModelOption[] = [
  { value: DEFAULT_MODEL, label: '跟随默认（不指定）' },
];

/**
 * Runtime-discovered TRAE model list, filled once at startup by
 * {@link refreshTraeModels}. `undefined` means "not probed yet / probe failed",
 * in which case we fall back to the hardcoded {@link TRAE_MODELS}. This keeps
 * external users (whose account may expose a different / smaller catalog than
 * the pinned list) from seeing internal-only ids they can't actually use.
 */
let traeModelsOverride: ModelOption[] | undefined;

/** The model picker options for a profile's agent kind. */
export function supportedModels(agentKind: AgentKind): ModelOption[] {
  if (agentKind === 'codex') return CODEX_MODELS;
  if (agentKind === 'trae') return traeModelsOverride ?? TRAE_MODELS;
  return CLAUDE_MODELS;
}

/**
 * Probe `traex models` and replace the picker list with the account's actual
 * catalog. Best-effort: any failure (missing binary, timeout, empty output)
 * leaves the hardcoded fallback in place. Safe to call more than once.
 */
export async function refreshTraeModels(
  command: string,
  options: { timeoutMs?: number } = {},
): Promise<ModelOption[] | undefined> {
  const timeoutMs = options.timeoutMs ?? 8000;
  let stdout = '';
  try {
    stdout = await new Promise<string>((resolve, reject) => {
      let out = '';
      let settled = false;
      const child = spawnProcess(command, ['models'], {
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        finish(() => reject(new Error('traex models timed out')));
      }, timeoutMs);
      child.stdout?.on('data', (chunk: Buffer) => {
        out += chunk.toString('utf8');
      });
      child.once('error', (err) => finish(() => reject(err)));
      child.once('exit', (code, signal) => {
        finish(() => {
          if (signal) return reject(new Error(`traex models signaled ${signal}`));
          if (code !== 0) return reject(new Error(`traex models exited ${code}`));
          resolve(out);
        });
      });
    });
  } catch (err) {
    log.warn('models', 'trae-probe-failed', { err: String(err) });
    return undefined;
  }

  const ids = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.includes(' '));
  if (ids.length === 0) {
    log.warn('models', 'trae-probe-empty', {});
    return undefined;
  }

  const seen = new Set<string>();
  const options_: ModelOption[] = [{ value: DEFAULT_MODEL, label: '跟随默认（不指定）' }];
  for (const id of ids) {
    if (id === DEFAULT_MODEL || seen.has(id)) continue;
    seen.add(id);
    // Label with the raw id — the account's live catalog is the source of
    // truth, and we deliberately keep no hardcoded id→label map (see
    // TRAE_MODELS) so no private model names live in the published source.
    options_.push({ value: id, label: id });
  }
  traeModelsOverride = options_;
  log.info('models', 'trae-probe-ok', { count: options_.length - 1 });
  return options_;
}

/** Reset the dynamic TRAE catalog back to the hardcoded fallback (tests). */
export function resetTraeModelsOverride(): void {
  traeModelsOverride = undefined;
}

/** True when the selection means "use the agent default" (no `--model`). */
export function isDefaultModel(value: string | undefined): boolean {
  return !value || value === DEFAULT_MODEL;
}

/**
 * Coerce a stored model preference into a value guaranteed to be one of the
 * current agent's picker options — Feishu's `select_static` requires
 * `initial_option` to match an option value exactly. Unknown / cross-agent
 * values (e.g. a Claude alias left over after switching a profile to Codex)
 * fall back to {@link DEFAULT_MODEL}.
 */
export function normalizeModelSelection(
  agentKind: AgentKind,
  value: string | undefined,
): string {
  if (isDefaultModel(value)) return DEFAULT_MODEL;
  return supportedModels(agentKind).some((m) => m.value === value)
    ? (value as string)
    : DEFAULT_MODEL;
}

/**
 * Resolve the concrete model string to hand the agent, or `undefined` to omit
 * the `--model` flag. Cross-agent / unknown values are treated as "default".
 */
export function resolveModelArg(
  agentKind: AgentKind,
  value: string | undefined,
): string | undefined {
  const normalized = normalizeModelSelection(agentKind, value);
  return normalized === DEFAULT_MODEL ? undefined : normalized;
}

/** Picker label for a stored value, for display in the saved-config card. */
export function modelLabel(agentKind: AgentKind, value: string | undefined): string {
  const normalized = normalizeModelSelection(agentKind, value);
  return supportedModels(agentKind).find((m) => m.value === normalized)?.label ?? normalized;
}
