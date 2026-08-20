import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_MODEL,
  isDefaultModel,
  modelLabel,
  normalizeModelSelection,
  refreshTraeModels,
  resetTraeModelsOverride,
  resolveModelArg,
  supportedModels,
} from '../../../src/agent/models.js';

describe('agent model catalog', () => {
  it('offers a distinct catalog per agent kind, each led by the default sentinel', () => {
    const claude = supportedModels('claude');
    const codex = supportedModels('codex');
    const trae = supportedModels('trae');
    expect(claude[0]?.value).toBe(DEFAULT_MODEL);
    expect(codex[0]?.value).toBe(DEFAULT_MODEL);
    expect(trae[0]?.value).toBe(DEFAULT_MODEL);
    expect(claude.map((m) => m.value)).toContain('claude-opus-4-8');
    expect(codex.map((m) => m.value)).toContain('gpt-5-codex');
    expect(claude.map((m) => m.value)).not.toContain('gpt-5-codex');
    // TRAE's real catalog is discovered at runtime (see refreshTraeModels);
    // the hardcoded fallback is intentionally just the default sentinel so no
    // account's private model ids are baked into the published source.
    expect(trae).toHaveLength(1);
    expect(trae[0]?.value).toBe(DEFAULT_MODEL);
  });

  it('treats unset and the default sentinel as "use agent default"', () => {
    expect(isDefaultModel(undefined)).toBe(true);
    expect(isDefaultModel('')).toBe(true);
    expect(isDefaultModel(DEFAULT_MODEL)).toBe(true);
    expect(isDefaultModel('claude-opus-4-8')).toBe(false);
  });

  it('coerces unknown / cross-agent selections back to the default option', () => {
    expect(normalizeModelSelection('claude', 'claude-opus-4-8')).toBe('claude-opus-4-8');
    // A Codex model left over after switching a profile to Claude is invalid.
    expect(normalizeModelSelection('claude', 'gpt-5-codex')).toBe(DEFAULT_MODEL);
    expect(normalizeModelSelection('claude', undefined)).toBe(DEFAULT_MODEL);
  });

  it('resolves the --model argument, omitting it for the default', () => {
    expect(resolveModelArg('claude', 'claude-sonnet-5')).toBe('claude-sonnet-5');
    expect(resolveModelArg('claude', DEFAULT_MODEL)).toBeUndefined();
    expect(resolveModelArg('claude', undefined)).toBeUndefined();
    // Cross-agent value → no flag rather than a broken model.
    expect(resolveModelArg('codex', 'claude-opus-4-8')).toBeUndefined();
    // TRAE only resolves ids present in its (runtime-discovered) catalog; with
    // the default-only fallback in place, an unknown id yields no flag.
    expect(resolveModelArg('trae', 'gpt-5-codex')).toBeUndefined();
    expect(resolveModelArg('trae', DEFAULT_MODEL)).toBeUndefined();
  });

  it('labels a stored value using the picker option text', () => {
    expect(modelLabel('claude', 'claude-opus-4-8')).toBe('Opus 4.8（最新）');
    expect(modelLabel('claude', DEFAULT_MODEL)).toContain('跟随默认');
  });
});

describe('dynamic TRAE model catalog', () => {
  afterEach(() => resetTraeModelsOverride());

  async function fakeTraex(stdout: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'fake-traex-'));
    const bin = join(dir, 'traex');
    await writeFile(bin, `#!/bin/sh\nprintf '%s' "${stdout.replace(/"/g, '\\"')}"\n`);
    await chmod(bin, 0o755);
    return bin;
  }

  it('replaces the picker with the account catalog and keeps default first', async () => {
    const bin = await fakeTraex('trae-model-a\ntrae-model-b\ntrae-model-c\n');
    const result = await refreshTraeModels(bin);
    expect(result).toBeDefined();
    const trae = supportedModels('trae');
    expect(trae[0]?.value).toBe(DEFAULT_MODEL);
    expect(trae.map((m) => m.value)).toEqual([
      DEFAULT_MODEL,
      'trae-model-a',
      'trae-model-b',
      'trae-model-c',
    ]);
    // Discovered ids are labelled with the raw id (no hardcoded id→label map).
    expect(modelLabel('trae', 'trae-model-a')).toBe('trae-model-a');
  });

  it('falls back to the hardcoded list when the probe fails', async () => {
    const before = supportedModels('trae').map((m) => m.value);
    const result = await refreshTraeModels('definitely-not-a-real-binary-xyz');
    expect(result).toBeUndefined();
    expect(supportedModels('trae').map((m) => m.value)).toEqual(before);
  });

  it('falls back when the probe returns empty output', async () => {
    const bin = await fakeTraex('\n  \n');
    const result = await refreshTraeModels(bin);
    expect(result).toBeUndefined();
    // Fallback is the default-only sentinel list.
    expect(supportedModels('trae').map((m) => m.value)).toEqual([DEFAULT_MODEL]);
  });
});
