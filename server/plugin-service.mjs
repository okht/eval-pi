import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, realpath, lstat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntime } from './runtime.mjs';
import { writeJson as saveJson } from './store.mjs';

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const readJson = async file => JSON.parse(await readFile(file, 'utf8'));
const counts = trials => Object.fromEntries(['pass', 'fail', 'pending', 'error'].map(verdict => [verdict, trials.filter(t => t.verdict === verdict).length]));

// An opaque session owns one runtime. Different Codex chats must open distinct
// sessions even when they evaluate the same project. No project path is used as
// a workspace key, and credentials never appear in returned artifacts.
export async function createPluginService({ appRoot, dataDir, modelsDataDir, pdfRenderer, runtimeFactory = createRuntime }) {
  if (!appRoot || !dataDir) throw new Error('appRoot and dataDir are required.');
  appRoot = await realpath(appRoot);
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  dataDir = await realpath(dataDir);
  const sessionsRoot = path.join(dataDir, 'sessions');
  await mkdir(sessionsRoot, { recursive: true, mode: 0o700 });
  if ((await lstat(sessionsRoot)).isSymbolicLink()) throw new Error('Session storage cannot be a symbolic link.');
  const active = new Map();
  let closing = false;

  async function directoryFor(sessionId) {
    if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) throw new Error('Invalid evaluation session ID.');
    const directory = path.join(sessionsRoot, sessionId);
    if ((await lstat(directory)).isSymbolicLink() || await realpath(directory) !== directory) throw new Error('Invalid session directory.');
    return directory;
  }

  async function acquire(directory) {
    // Fail closed across MCP processes, including abandoned locks after a crash.
    // Saved evidence remains readable; a fresh session can always be opened.
    // Never guess that another process is dead and delete its live lock.
    const lockPath = path.join(directory, '.plugin-lock');
    let handle;
    try { handle = await open(lockPath, 'wx', 0o600); }
    catch (error) {
      if (error.code === 'EEXIST') throw new Error('This session is locked by another plugin process. Close it there, or open a new session. After a crash, preserve the evidence and remove the inactive .plugin-lock manually.');
      throw error;
    }
    const token = randomUUID();
    try { await handle.writeFile(JSON.stringify({ token, pid: process.pid, createdAt: new Date().toISOString() })); }
    finally { await handle.close(); }
    let released = false;
    return async () => {
      if (released) return;
      if ((await readJson(lockPath)).token !== token) throw new Error('Session lock ownership changed.');
      await unlink(lockPath);
      released = true;
    };
  }

  async function validateStorage(directory) {
    for (const name of ['workspace.json', 'session.json', 'plan.json', 'runs', 'reports']) {
      try {
        if ((await lstat(path.join(directory, name))).isSymbolicLink()) throw new Error('Session files and artifact directories cannot be symbolic links.');
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    let saved;
    try { saved = await readJson(path.join(directory, 'workspace.json')); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (!saved.run) return;
    if (!saved.plan || saved.run.planId !== saved.plan.id || typeof saved.run.directory !== 'string') throw new Error('Saved run does not belong to the session plan.');
    const relative = path.relative(path.join(directory, 'runs'), saved.run.directory);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || await realpath(saved.run.directory) !== path.resolve(saved.run.directory)) throw new Error('Saved run directory is outside this evaluation session.');
    try {
      if ((await lstat(path.join(saved.run.directory, 'run.json'))).isSymbolicLink()) throw new Error('Run evidence cannot be a symbolic link.');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }

  async function load(sessionId, initialize = false, allowClosing = false) {
    if (closing) throw new Error('EvalPi plugin is shutting down.');
    if (active.has(sessionId)) {
      const session = await active.get(sessionId);
      if (session.closePromise && !allowClosing) throw new Error('This evaluation session is closing.');
      return session;
    }
    const pending = (async () => {
      const directory = await directoryFor(sessionId);
      const metadata = await readJson(path.join(directory, 'session.json'));
      if (metadata.id !== sessionId || metadata.version !== 1) throw new Error('Invalid session metadata.');
      const release = await acquire(directory);
      let runtime;
      try {
        await validateStorage(directory);
        runtime = await runtimeFactory({ appRoot, dataDir: directory, modelsDataDir: modelsDataDir ?? path.join(dataDir, 'models'), pdfRenderer });
        if (initialize) await runtime.selectProject(metadata.projectPath);
        else if (runtime.snapshot().project?.path !== metadata.projectPath) throw new Error('Session project does not match its saved workspace.');
        return { id: sessionId, directory, runtime, release };
      } catch (error) {
        await runtime?.dispose();
        await release();
        throw error;
      }
    })();
    active.set(sessionId, pending);
    try { return await pending; }
    catch (error) { active.delete(sessionId); throw error; }
  }

  function operate(session, fn) {
    if (closing || session.closePromise) throw new Error('This evaluation session is closing.');
    if (session.operation) throw new Error('Another plugin request is updating this session. Wait for it to finish.');
    const operation = Promise.resolve().then(fn).finally(() => { session.operation = null; });
    session.operation = operation;
    return operation;
  }

  function closeSession(session) {
    if (!session.closePromise) session.closePromise = (async () => {
      await Promise.allSettled([session.operation]);
      await session.runtime.dispose();
      await session.release();
      active.delete(session.id);
      return { sessionId: session.id, closed: true, workspacePath: path.join(session.directory, 'workspace.json') };
    })();
    return session.closePromise;
  }

  async function savePlan(session) {
    const plan = session.runtime.snapshot().plan;
    if (plan) await saveJson(path.join(session.directory, 'plan.json'), plan);
  }

  function summarize(session, includeProject = false) {
    const { project, plan, run, busy, activity, error, model } = session.runtime.snapshot();
    const result = {
      sessionId: session.id, busy, activity, error,
      project: project && { path: project.path, name: project.name, runnable: project.runnable, ...(includeProject ? { summary: project.summary, files: project.files } : {}) },
      model: { provider: model.provider, model: model.model, authenticated: model.authenticated, authMode: model.authMode },
      plan: plan && { id: plan.id, title: plan.title, goal: plan.goal, criteria: plan.criteria, entry: plan.entry, judge: plan.judge, repeats: plan.repeats, timeoutMs: plan.timeoutMs, confirmed: plan.confirmed, caseCount: plan.cases.length, plannedTrials: plan.cases.length * plan.repeats },
      run: run && { id: run.id, status: run.status, planned: run.planned, recorded: run.trials.length, originalVerdicts: counts(run.trials), reviews: run.reviews, recheckCount: run.rechecks?.length ?? 0,
        cases: [...new Set(run.trials.map(t => t.caseId))].map(caseId => ({ caseId, ...counts(run.trials.filter(t => t.caseId === caseId)), review: run.reviews?.[caseId] ?? null })) },
      files: { workspace: path.join(session.directory, 'workspace.json'), ...(plan ? { plan: path.join(session.directory, 'plan.json') } : {}), ...(run ? { evidence: path.join(run.directory, 'run.json') } : {}) },
    };
    if (plan?.judge === 'llm' && !model.authenticated) result.nextAction = 'Connect a judge model in EvalPi, then prepare the plugin with --models-dir pointing to that workspace/models directory. No credentials are inherited from Codex.';
    return result;
  }

  function requireRun(session, runId) {
    const run = session.runtime.snapshot().run;
    if (typeof runId !== 'string' || !run || run.id !== runId) throw new Error('Run changed. Fetch the current session status before continuing.');
    return run;
  }

  const service = {
    async open({ projectPath }) {
      if (closing) throw new Error('EvalPi plugin is shutting down.');
      if (typeof projectPath !== 'string' || !path.isAbsolute(projectPath)) throw new Error('projectPath must be an absolute local directory.');
      const projectRoot = await realpath(projectPath);
      const id = randomUUID(), directory = path.join(sessionsRoot, id);
      await mkdir(directory, { mode: 0o700 });
      await saveJson(path.join(directory, 'session.json'), { version: 1, id, projectPath: projectRoot, createdAt: new Date().toISOString() });
      const session = await load(id, true);
      await savePlan(session);
      return summarize(session, true);
    },
    async status({ sessionId }) { return summarize(await load(sessionId)); },
    async submitPlan({ sessionId, plan }) {
      const session = await load(sessionId);
      return operate(session, async () => {
      await session.runtime.submitPlan(plan);
      await savePlan(session);
      return summarize(session);
      });
    },
    async confirm({ sessionId, planId }) {
      const session = await load(sessionId);
      return operate(session, async () => {
      await session.runtime.confirm(planId);
      await savePlan(session);
      return summarize(session);
      });
    },
    async start({ sessionId, planId }) {
      const session = await load(sessionId);
      return operate(session, async () => {
      await session.runtime.start(planId);
      return summarize(session);
      });
    },
    async results({ sessionId, runId, offset = 0, limit = 10 }) {
      if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error('Use offset >= 0 and limit between 1 and 20.');
      const session = await load(sessionId), run = requireRun(session, runId);
      return { sessionId, runId, total: run.trials.length, offset, nextOffset: offset + limit < run.trials.length ? offset + limit : null,
        evidencePath: path.join(run.directory, 'run.json'),
        trials: run.trials.slice(offset, offset + limit).map(trial => {
          const evidence = JSON.stringify({ output: trial.output, trace: trial.trace });
          const rechecks = (run.rechecks ?? []).filter(r => r.trialId === trial.id);
          return { id: trial.id, caseId: trial.caseId, trial: trial.trial, status: trial.status, verdict: trial.verdict, reason: trial.reason,
            review: run.reviews?.[trial.caseId] ?? null, rechecks: rechecks.slice(-5), recheckCount: rechecks.length,
            evidencePreview: evidence.slice(0, 6000), evidenceTruncated: evidence.length > 6000 };
        }) };
    },
    async review({ sessionId, runId, decisions }) {
      const session = await load(sessionId);
      return operate(session, async () => {
      requireRun(session, runId);
      await session.runtime.review(decisions, runId);
      return summarize(session);
      });
    },
    async retryGrading({ sessionId, runId }) {
      const session = await load(sessionId);
      return operate(session, async () => {
      await session.runtime.retryGrading(runId);
      return summarize(session);
      });
    },
    async cancel({ sessionId }) {
      const session = await load(sessionId);
      await session.runtime.cancel();
      return summarize(session);
    },
    async report({ sessionId, runId }) {
      const session = await load(sessionId);
      return operate(session, async () => {
      requireRun(session, runId);
      await validateStorage(session.directory);
      const result = await session.runtime.report();
      const stem = result.filename.replace(/-report\.html$/, '');
      const artifacts = [[result.filename, 'text/html'], [`${stem}-results.csv`, 'text/csv'], [`${stem}-traces.jsonl`, 'application/x-ndjson'], [`${stem}-snapshot.json`, 'application/json']];
      if (result.pdfUrl) artifacts.unshift([result.filename.replace(/\.html$/, '.pdf'), 'application/pdf']);
      const files = await Promise.all(artifacts.map(async ([name, mimeType]) => {
        if (path.basename(name) !== name) throw new Error('Invalid report filename.');
        const filename = path.join(session.directory, 'reports', name);
        if (!(await lstat(filename)).isFile()) throw new Error('Report artifact is missing.');
        return { name, path: filename, mimeType, uri: pathToFileURL(filename).href };
      }));
      return { sessionId, runId, files, warning: session.runtime.snapshot().error };
      });
    },
    async close({ sessionId }) {
      const session = await load(sessionId, false, true);
      // Keep the reservation until cancellation and durable evidence writes finish.
      return closeSession(session);
    },
    async dispose() {
      closing = true;
      await Promise.allSettled([...active.values()].map(async pending => {
        const session = await pending;
        await closeSession(session);
      }));
      active.clear();
    },
  };
  return service;
}
