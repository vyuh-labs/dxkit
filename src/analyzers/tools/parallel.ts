/**
 * Parallel tool execution — run Layer 2 gather functions concurrently
 * by forking child processes that call the EXISTING gather functions.
 *
 * Each child process requires the built dist/ module and calls the same
 * gather function that sequential mode uses. NO duplicated invocation logic.
 *
 * Architecture rule (CLAUDE.md #2): each tool has ONE gather function.
 * This module orchestrates, never reimplements.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import { HealthMetrics } from '../types';

interface GatherTask {
  name: string;
  /** Node.js require path + function call that returns Partial<HealthMetrics> */
  modulePath: string;
  functionName: string;
}

/**
 * Run cloc + gitleaks + graphify gather functions in parallel child processes.
 * Each child calls the real gather function from the existing tool module.
 * Falls back to sequential on low memory (<1GB free).
 */
export function gatherLayer2Parallel(cwd: string, verbose = false): Partial<HealthMetrics> {
  const dxkitDist = path.resolve(__dirname, '..');

  const tasks: GatherTask[] = [
    {
      name: 'cloc',
      modulePath: './cloc',
      functionName: 'gatherClocMetrics',
    },
    {
      name: 'gitleaks',
      modulePath: './gitleaks',
      functionName: 'gatherGitleaksMetrics',
    },
    {
      name: 'graphify',
      modulePath: './graphify',
      functionName: 'gatherGraphifyMetrics',
    },
  ];

  // Check available memory — fall back to sequential if <1GB free
  const freeMem = os.freemem();
  const useParallel = freeMem >= 1024 * 1024 * 1024;

  if (verbose && !useParallel) {
    console.error(
      `  [parallel] Low memory (${Math.round(freeMem / 1024 / 1024)}MB free), running sequentially`,
    );
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-l2-'));
  const startTime = Date.now();

  if (useParallel) {
    runTasksParallel(tasks, cwd, dxkitDist, tmpDir, verbose);
  } else {
    runTasksSequential(tasks, cwd, dxkitDist, tmpDir);
  }

  if (verbose) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.error(`  [parallel] Layer 2 completed in ${elapsed}s`);
  }

  // Merge all results
  const merged: Partial<HealthMetrics> = {
    toolsUsed: [],
    toolsUnavailable: [],
  };

  for (let i = 0; i < tasks.length; i++) {
    const resultFile = path.join(tmpDir, `${tasks[i].name}.json`);
    try {
      const raw = fs.readFileSync(resultFile, 'utf-8');
      const partial = JSON.parse(raw) as Partial<HealthMetrics>;
      // Merge arrays
      if (partial.toolsUsed) {
        (merged.toolsUsed as string[]).push(...partial.toolsUsed);
        delete partial.toolsUsed;
      }
      if (partial.toolsUnavailable) {
        (merged.toolsUnavailable as string[]).push(...partial.toolsUnavailable);
        delete partial.toolsUnavailable;
      }
      // Merge non-null values
      for (const [k, v] of Object.entries(partial)) {
        if (v !== null && v !== undefined) {
          (merged as Record<string, unknown>)[k] = v;
        }
      }
    } catch {
      // Tool didn't produce output — skip
    }
  }

  // Cleanup
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }

  return merged;
}

/** Build the Node.js script that calls a gather function and writes result to file. */
function buildWorkerScript(task: GatherTask, cwd: string, resultFile: string): string {
  // The child process requires the SAME compiled module and calls the SAME function.
  // No duplication — it's literally require('<abs-path>/tools/cloc').gatherClocMetrics(cwd).
  // Use __dirname at build time to resolve the absolute path to dist/analyzers/.
  const absModulePath = path.resolve(__dirname, task.modulePath);
  return `
    try {
      var mod = require('${absModulePath.replace(/\\/g, '/')}');
      var result = mod.${task.functionName}('${cwd.replace(/'/g, "\\'")}');
      require('fs').writeFileSync('${resultFile}', JSON.stringify(result));
    } catch (e) {
      require('fs').writeFileSync('${resultFile}', JSON.stringify({
        toolsUnavailable: ['${task.name} (child process error: ' + (e.message || '').slice(0, 100) + ')']
      }));
    }
  `;
}

function runTasksParallel(
  tasks: GatherTask[],
  cwd: string,
  dxkitDist: string,
  tmpDir: string,
  _verbose: boolean,
): void {
  // Write each task as a standalone Node script file, then run all via bash `&` + `wait`.
  // This gives true OS-level parallelism without poll overhead.
  const scriptPaths: string[] = [];

  for (const task of tasks) {
    const resultFile = path.join(tmpDir, `${task.name}.json`);
    const workerScript = buildWorkerScript(task, cwd, resultFile);
    const scriptPath = path.join(tmpDir, `${task.name}.js`);
    fs.writeFileSync(scriptPath, workerScript);
    scriptPaths.push(scriptPath);
  }

  // Bash script that backgrounds all node processes and waits
  const bashLines = scriptPaths.map((sp) => `node '${sp}' &`);
  bashLines.push('wait');
  const bashScript = path.join(tmpDir, 'run-parallel.sh');
  fs.writeFileSync(bashScript, '#!/bin/bash\n' + bashLines.join('\n') + '\n');
  fs.chmodSync(bashScript, 0o755);

  try {
    execSync(bashScript, {
      cwd: dxkitDist,
      stdio: 'ignore',
      timeout: 300000,
      env: process.env,
    });
  } catch {
    // Timeout or error — still try to read whatever completed
  }
}

function runTasksSequential(
  tasks: GatherTask[],
  cwd: string,
  dxkitDist: string,
  tmpDir: string,
): void {
  for (const task of tasks) {
    const resultFile = path.join(tmpDir, `${task.name}.json`);
    const script = buildWorkerScript(task, cwd, resultFile);
    try {
      execSync(`node -e '${script.replace(/'/g, "'\\''")}'`, {
        cwd: dxkitDist,
        stdio: 'ignore',
        timeout: 180000,
      });
    } catch {
      /* continue with next tool */
    }
  }
}
