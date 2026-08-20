import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexAdapter } from '../../src/agent/codex/adapter.js';
import { buildCodexArgs } from '../../src/agent/codex/argv.js';
import type { AgentEvent } from '../../src/agent/types.js';

interface FakeBinary {
  path: string;
  dir: string;
  recordPath: string;
}

/**
 * TRAE CLI (`traex`) is a Codex fork, so it runs through {@link CodexAdapter}
 * with a `trae` identity override. These tests pin the two things that make a
 * TRAE profile first-class rather than a relabeled Codex run: (1) the adapter
 * still speaks the exact Codex argv + JSONL contract when driven as trae, and
 * (2) the adapter surfaces the TRAE identity (`id`/`displayName`) instead of
 * Codex's.
 */
describe('TRAE adapter (Codex-fork) process contract', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(
      cleanup.splice(0).map((dir) =>
        rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }),
      ),
    );
  });

  it('surfaces the TRAE identity when constructed with the trae override', () => {
    const adapter = new CodexAdapter({
      binary: 'traex',
      profileStateDir: tmpdir(),
      agentId: 'trae',
      displayName: 'TRAE CLI',
    });
    expect(adapter.id).toBe('trae');
    expect(adapter.displayName).toBe('TRAE CLI');
  });

  it('defaults to the Codex identity when no override is given', () => {
    const adapter = new CodexAdapter({ binary: 'codex', profileStateDir: tmpdir() });
    expect(adapter.id).toBe('codex');
    expect(adapter.displayName).toBe('Codex CLI');
  });

  it('drives a fresh JSON run through the shared Codex argv + JSONL contract', async () => {
    const fake = await createFakeTrae({
      lines: [
        { type: 'thread.started', thread_id: 'thread-trae' },
        { type: 'agent_message', message: 'hi from trae' },
        { type: 'turn.completed' },
      ],
    });
    cleanup.push(fake.dir);
    const cwd = await realpath(fake.dir);

    const run = new CodexAdapter({
      binary: fake.path,
      profileStateDir: fake.dir,
      agentId: 'trae',
      displayName: 'TRAE CLI',
      sandbox: 'read-only',
    }).run({
      runId: 'run-trae-fresh',
      prompt: 'hello from lark',
      cwd,
    });

    expect(run.runId).toBe('run-trae-fresh');
    expect(await collect(run.events)).toEqual([
      { type: 'system', threadId: 'thread-trae' },
      { type: 'final_text', content: 'hi from trae' },
      { type: 'done', threadId: 'thread-trae', terminationReason: 'normal' },
    ]);
    const record = await readRecord(fake.recordPath);
    expect(record.argv).toEqual(buildCodexArgs({ cwd, sandbox: 'read-only' }));
    expect(record.stdin).toContain('hello from lark');
    expect(record.stdin).not.toBe('hello from lark');
    expect(record.env).toMatchObject({ LARK_CHANNEL: '1' });
  });

  it('ignores TRAE-specific extra JSONL events (e.g. model_reroute) and waits for the turn', async () => {
    const fake = await createFakeTrae({
      lines: [
        { type: 'thread.started', thread_id: 'thread-reroute' },
        { type: 'model_reroute', from: 'trae-model-a', to: 'trae-model-b' },
        { type: 'agent_message', message: 'after reroute' },
        { type: 'turn.completed' },
      ],
    });
    cleanup.push(fake.dir);

    const run = new CodexAdapter({
      binary: fake.path,
      profileStateDir: fake.dir,
      agentId: 'trae',
      displayName: 'TRAE CLI',
    }).run({
      runId: 'run-trae-reroute',
      prompt: 'reroute',
      cwd: await realpath(fake.dir),
    });

    expect(await collect(run.events)).toEqual([
      { type: 'system', threadId: 'thread-reroute' },
      { type: 'final_text', content: 'after reroute' },
      { type: 'done', threadId: 'thread-reroute', terminationReason: 'normal' },
    ]);
  });

  it('resumes an existing TRAE thread through the Codex argv contract', async () => {
    const fake = await createFakeTrae({ lines: [{ type: 'turn.completed' }] });
    cleanup.push(fake.dir);
    const cwd = await realpath(fake.dir);

    const run = new CodexAdapter({
      binary: fake.path,
      profileStateDir: fake.dir,
      agentId: 'trae',
      displayName: 'TRAE CLI',
      sandbox: 'workspace-write',
    }).run({
      runId: 'run-trae-resume',
      prompt: 'continue',
      cwd,
      threadId: 'thread-old',
    });

    expect(await collect(run.events)).toEqual([
      { type: 'done', terminationReason: 'normal' },
    ]);
    const record = await readRecord(fake.recordPath);
    expect(record.argv).toEqual(
      buildCodexArgs({ cwd, sandbox: 'workspace-write', threadId: 'thread-old' }),
    );
  });
});

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

async function createFakeTrae(options: {
  lines: unknown[];
  stderr?: string;
  exitCode?: number;
}): Promise<FakeBinary> {
  const dir = await mkdtemp(join(tmpdir(), 'trae-adapter-test-'));
  const path = join(dir, 'fake-trae.mjs');
  const recordPath = join(dir, 'argv.json');
  await writeFile(
    path,
    [
      '#!/usr/bin/env node',
      'import { writeFileSync } from "node:fs";',
      'let stdin = "";',
      'process.stdin.setEncoding("utf8");',
      'process.stdin.on("data", (chunk) => { stdin += chunk; });',
      'process.stdin.on("end", () => {',
      `  writeFileSync(${JSON.stringify(recordPath)}, JSON.stringify({`,
      '    argv: process.argv.slice(2),',
      '    cwd: process.cwd(),',
      '    stdin,',
      '    env: { LARK_CHANNEL: process.env.LARK_CHANNEL, CODEX_HOME: process.env.CODEX_HOME },',
      '  }));',
      `  const lines = ${JSON.stringify(options.lines)};`,
      '  for (const line of lines) console.log(JSON.stringify(line));',
      options.stderr ? `  process.stderr.write(${JSON.stringify(options.stderr)});` : '',
      `  setTimeout(() => process.exit(${options.exitCode ?? 0}), 0);`,
      '});',
    ].filter(Boolean).join('\n'),
    'utf8',
  );
  await chmod(path, 0o755);
  return { path, dir, recordPath };
}

async function readRecord(path: string): Promise<{
  argv: string[];
  cwd: string;
  stdin: string;
  env: { LARK_CHANNEL?: string; CODEX_HOME?: string };
}> {
  return JSON.parse(await readFile(path, 'utf8')) as {
    argv: string[];
    cwd: string;
    stdin: string;
    env: { LARK_CHANNEL?: string; CODEX_HOME?: string };
  };
}
