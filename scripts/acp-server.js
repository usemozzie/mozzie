#!/usr/bin/env node
/**
 * Mozzie ACP Bridge Server
 *
 * Wraps a local CLI coding agent (claude, gemini, codex) in an HTTP server
 * that speaks the BeeAI Agent Communication Protocol (ACP).
 *
 * Usage:
 *   node acp-server.js --agent claude-code --port 8330
 *   node acp-server.js --agent gemini-cli  --port 8331
 *   node acp-server.js --agent codex-cli   --port 8332
 *
 * Or via environment variables:
 *   AGENT=claude-code PORT=8330 node acp-server.js
 */

const http = require('http');
const { spawn } = require('child_process');

// ─── CLI arg parsing ──────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function getArg(name) {
  const flag = `--${name}`;
  const idx = args.indexOf(flag);
  return idx !== -1 ? args[idx + 1] : undefined;
}

const AGENT = getArg('agent') || process.env.AGENT || 'claude-code';
const PORT  = parseInt(getArg('port') || process.env.PORT || '8330', 10);

function resolveAgentCommand(baseName, envVar) {
  const override = process.env[envVar]?.trim();
  if (override) return override;

  // On Windows, npm global CLIs are commonly exposed as .cmd shims.
  // child_process.spawn() with shell:false does not reliably resolve those
  // from a bare command name, so choose the shim explicitly.
  if (process.platform === 'win32') {
    return `${baseName}.cmd`;
  }

  return baseName;
}

// ─── Agent definitions ────────────────────────────────────────────────────────
// Prompts are passed via STDIN to avoid shell quoting issues on Windows.
// stdinPrompt: true  → write prompt to proc.stdin then close it
// stdinPrompt: false → pass prompt as last CLI argument

const AGENTS = {
  'claude-code': {
    cmd: resolveAgentCommand('claude', 'CLAUDE_CMD'),
    // --print: non-interactive output mode
    // --dangerously-skip-permissions: skip interactive approval prompts
    // Remove --dangerously-skip-permissions if you want Claude to ask before acting.
    args: ['--print', '--dangerously-skip-permissions'],
    stdinPrompt: true,  // pass prompt via stdin, not as shell arg
    env: {},
  },
  'gemini-cli': {
    cmd: resolveAgentCommand('gemini', 'GEMINI_CMD'),
    args: [],
    stdinPrompt: true,
    env: {},
  },
  'codex-cli': {
    cmd: resolveAgentCommand('codex', 'CODEX_CMD'),
    args: ['--full-auto'],
    stdinPrompt: true,
    env: {},
  },
};

const agentDef = AGENTS[AGENT];
if (!agentDef) {
  console.error(`Unknown agent: ${AGENT}. Valid agents: ${Object.keys(AGENTS).join(', ')}`);
  process.exit(1);
}

// ─── SSE helpers ──────────────────────────────────────────────────────────────

function sse(res, event) {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

// ─── Request handler ──────────────────────────────────────────────────────────

function handleRun(req, res) {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    let runReq;
    try {
      runReq = JSON.parse(body);
    } catch (err) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: `Invalid JSON: ${err.message}` }));
      return;
    }

    // Extract prompt from ACP message parts.
    const parts  = runReq.input?.[0]?.parts ?? [];
    const prompt = parts.map((p) => p.content ?? '').join('\n').trim();
    // cwd is a non-standard extension added by Mozzie's launch_agent command.
    const cwd    = runReq.cwd || process.cwd();

    if (!prompt) {
      res.statusCode = 422;
      res.end(JSON.stringify({ error: 'No prompt content in input' }));
      return;
    }

    // Start SSE stream.
    res.writeHead(200, {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection':    'keep-alive',
    });

    const runId = `run-${Date.now()}`;
    sse(res, { type: 'run.created',     run: { id: runId, status: 'created' } });
    sse(res, { type: 'run.in-progress', run: { id: runId, status: 'running' } });
    sse(res, { type: 'message.created', message: { role: 'assistant' } });

    console.log(`[${AGENT}] run ${runId} — cwd: ${cwd}`);
    console.log(`[${AGENT}] prompt: ${prompt.slice(0, 120)}${prompt.length > 120 ? '…' : ''}`);

    // Build spawn args — prompt goes via stdin to avoid Windows quoting issues.
    const spawnArgs = agentDef.stdinPrompt
      ? [...agentDef.args]
      : [...agentDef.args, prompt];

    const needsShell = process.platform === 'win32' && /\.cmd$/i.test(agentDef.cmd);

    const proc = spawn(agentDef.cmd, spawnArgs, {
      cwd,
      env: { ...process.env, ...agentDef.env },
      // Windows npm global CLIs are often .cmd shims, which require a shell.
      // For real executables we keep shell disabled to avoid extra quoting issues.
      shell: needsShell,
      // stdio: pipe all three streams so we can read stdout/stderr and write stdin.
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Write prompt via stdin and close the write end.
    if (agentDef.stdinPrompt && proc.stdin) {
      proc.stdin.write(prompt, 'utf8');
      proc.stdin.end();
    }

    function sendText(text) {
      if (!text) return;
      sse(res, { type: 'message.part', part: { content: text, content_type: 'text/plain' } });
    }

    proc.stdout.on('data', (data) => sendText(data.toString()));
    // stderr: many CLI tools write progress/thinking to stderr — show it too.
    proc.stderr.on('data', (data) => {
      const text = data.toString();
      console.error(`[${AGENT}] stderr:`, text.trimEnd());
      sendText(text);
    });

    proc.on('error', (err) => {
      const msg = err.code === 'ENOENT'
        ? `Command not found: "${agentDef.cmd}". Is it installed and on PATH?`
        : `Failed to start ${agentDef.cmd}: ${err.message}`;
      console.error(`[${AGENT}] spawn error:`, msg);
      sse(res, { type: 'error', error: { message: msg } });
      res.end();
    });

    proc.on('close', (code, signal) => {
      console.log(`[${AGENT}] run ${runId} exited — code: ${code}, signal: ${signal}`);
      sse(res, { type: 'message.completed', message: { role: 'assistant' } });
      if (code === 0) {
        sse(res, { type: 'run.completed', run: { id: runId, status: 'completed' } });
      } else {
        const reason = signal
          ? `Killed by signal ${signal}`
          : `Process exited with code ${code}`;
        sse(res, {
          type: 'run.failed',
          run: { id: runId, status: 'failed', error: { message: reason } },
        });
      }
      res.end();
    });

    // If the Tauri client disconnects mid-run, kill the agent process.
    req.on('close', () => {
      if (!proc.killed) {
        console.log(`[${AGENT}] client disconnected — killing run ${runId}`);
        proc.kill('SIGTERM');
      }
    });
  });
}

// ─── HTTP server ──────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === 'POST' && req.url === '/runs') {
    handleRun(req, res);
    return;
  }

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ agent: AGENT, status: 'ok' }));
    return;
  }

  res.statusCode = 404;
  res.end();
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Mozzie ACP bridge [${AGENT}] listening on http://localhost:${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});
