const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  buildReadProgressRules,
  createReadProgressGuard,
  createReadProgressController,
  extractReadInspection,
  extractBoundedRange
} = require('../native-host/src/readProgressGuard');
const { runCodexAppServerSession } = require('../native-host/src/codexSessionRunner');

test('parses bounded sed and head reads without treating a broad cat as trustworthy coverage', () => {
  assert.deepEqual(extractBoundedRange("sed -n '274,497p' /tmp/project/main.tex"), {
    startLine: 274,
    endLine: 497,
    path: '/tmp/project/main.tex'
  });
  assert.deepEqual(extractBoundedRange('head -n 120 "sections/proof.tex"'), {
    startLine: 1,
    endLine: 120,
    path: 'sections/proof.tex'
  });
  assert.equal(extractBoundedRange('cat /tmp/project/main.tex'), null);
});

test('steers after consecutive high-overlap reads while allowing a long non-overlapping scan', () => {
  const workspacePath = '/tmp/project';
  const guard = createReadProgressGuard({ workspacePath });
  const ranges = [
    [274, 497],
    [500, 700],
    [700, 960],
    [958, 1245],
    [1243, 1600],
    [154, 275],
    [733, 822],
    [1361, 1540]
  ];
  const decisions = ranges.map(([start, end]) => guard.observe(readItem(
    `sed -n '${start},${end}p' ${workspacePath}/main.tex`,
    `${workspacePath}/main.tex`
  )));

  assert.equal(decisions.slice(0, -1).every(decision => decision.action === 'none'), true);
  assert.equal(decisions.at(-1).action, 'steer');
  assert.equal(decisions.at(-1).evidence.file, 'main.tex');
  assert.equal(decisions.at(-1).evidence.overlapRatio, 1);

  const cleanGuard = createReadProgressGuard({ workspacePath });
  for (let index = 0; index < 14; index += 1) {
    const start = index * 100 + 1;
    const decision = cleanGuard.observe(readItem(
      `sed -n '${start},${start + 99}p' ${workspacePath}/main.tex`,
      `${workspacePath}/main.tex`
    ));
    assert.equal(decision.action, 'none');
  }
});

test('aborts after a model ignores steering and repeats two more covered ranges', () => {
  const workspacePath = '/tmp/project';
  const guard = createReadProgressGuard({
    workspacePath,
    minReadCommands: 2,
    redundantStreak: 1,
    postSteerRedundantStreak: 2
  });
  guard.observe(readItem("sed -n '1,100p' /tmp/project/main.tex", '/tmp/project/main.tex'));
  assert.equal(
    guard.observe(readItem("sed -n '1,100p' /tmp/project/main.tex", '/tmp/project/main.tex')).action,
    'steer'
  );
  guard.acknowledgeSteer();
  assert.equal(
    guard.observe(readItem("sed -n '1,100p' /tmp/project/main.tex", '/tmp/project/main.tex')).action,
    'none'
  );
  assert.equal(
    guard.observe(readItem("sed -n '1,100p' /tmp/project/main.tex", '/tmp/project/main.tex')).action,
    'abort'
  );
});

test('app-server runner steers a repeated-read turn and preserves its final answer', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-read-progress-'));
  const events = [];
  try {
    const fakeCodex = writeFakeCodexRepeatedReads(tempDir);
    const result = await Promise.race([
      runCodexAppServerSession({
        task: buildReadProgressRules(),
        mode: 'ask',
        workspacePath: tempDir,
        env: {
          CODEX_OVERLEAF_ENV_READY: '1',
          CODEX_OVERLEAF_CODEX_PATH: fakeCodex,
          PATH: process.env.PATH
        },
        emit: event => events.push(event)
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('read progress integration timed out')), 5000))
    ]);

    assert.equal(result.assistantMessage, 'Synthesized after the progress correction.');
    const steerEvent = events.find(event => event.type === 'codex.no_progress.steered');
    assert.ok(steerEvent);
    assert.equal(steerEvent.detail.file, 'main.tex');
    assert.equal(steerEvent.detail.guardAction, 'steer');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

function readItem(command, filePath) {
  return {
    id: `command-${command}`,
    type: 'commandExecution',
    status: 'completed',
    command,
    cwd: path.dirname(filePath),
    commandActions: [{
      type: 'read',
      command,
      name: path.basename(filePath),
      path: filePath
    }]
  };
}

function writeFakeCodexRepeatedReads(tempDir) {
  const scriptPath = path.join(tempDir, 'fake-codex-read-progress.js');
  const projectFile = path.join(tempDir, 'main.tex');
  fs.writeFileSync(scriptPath, [
    "const readline = require('node:readline');",
    "const rl = readline.createInterface({ input: process.stdin });",
    "function send(message) { process.stdout.write(`${JSON.stringify(message)}\\n`); }",
    `const projectFile = ${JSON.stringify(projectFile)};`,
    "const ranges = [[274,497],[500,700],[700,960],[958,1245],[1243,1600],[154,275],[733,822],[1361,1540]];",
    "function item(start, end, index) {",
    "  const command = `sed -n '${start},${end}p' ${projectFile}`;",
    "  return { id: `cmd-${index}`, type: 'commandExecution', status: 'completed', command, cwd: require('node:path').dirname(projectFile), commandActions: [{ type: 'read', command, name: 'main.tex', path: projectFile }] };",
    "}",
    "rl.on('line', line => {",
    "  const message = JSON.parse(line);",
    "  if (message.id && message.method === 'initialize') { send({ id: message.id, result: {} }); return; }",
    "  if (message.method === 'initialized') return;",
    "  if (message.id && message.method === 'thread/start') { send({ id: message.id, result: { thread: { id: 'thread-1' } } }); return; }",
    "  if (message.id && message.method === 'turn/start') {",
    "    send({ id: message.id, result: { turn: { id: 'turn-1' } } });",
    "    send({ method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-1' } } });",
    "    ranges.forEach(([start, end], index) => send({ method: 'item/completed', params: { threadId: 'thread-1', turnId: 'turn-1', item: item(start, end, index) } }));",
    "    return;",
    "  }",
    "  if (message.id && message.method === 'turn/steer') {",
    "    if (!String(message.params?.input?.[0]?.text || '').includes('Stop issuing inspection commands')) process.exit(4);",
    "    send({ id: message.id, result: {} });",
    "    send({ method: 'item/agentMessage/delta', params: { itemId: 'msg-1', delta: 'Synthesized after the progress correction.' } });",
    "    send({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } } });",
    "  }",
    "});",
    "process.on('SIGTERM', () => process.exit(0));",
    ''
  ].join('\n'), 'utf8');
  if (process.platform === 'win32') {
    const commandPath = path.join(tempDir, 'codex.cmd');
    fs.writeFileSync(commandPath, ['@echo off', `"${process.execPath}" "${scriptPath}" %*`, ''].join('\r\n'));
    return commandPath;
  }
  const commandPath = path.join(tempDir, 'codex');
  fs.writeFileSync(commandPath, ['#!/usr/bin/env node', `require(${JSON.stringify(scriptPath)});`, ''].join('\n'));
  fs.chmodSync(commandPath, 0o755);
  return commandPath;
}

test('stdin pagination without a proven file never creates shared range coverage', () => {
  const guard = createReadProgressGuard({ workspacePath: '/qa' });
  for (let index = 0; index < 8; index += 1) {
    const command = "rg -n 'topic" + index + "' section" + index + ".tex | sed -n '1,240p'";
    assert.equal(extractBoundedRange(command), null);
    assert.equal(extractReadInspection({ type: 'commandExecution', command }, '/qa'), null);
    assert.equal(guard.observe({ type: 'commandExecution', command }).action, 'none');
  }
  assert.equal(extractBoundedRange("sed -n '1,240p'"), null);
  assert.equal(extractBoundedRange("sed -n '1,240p' -"), null);
  const metadata = extractReadInspection(readItem("nl -ba Thesis.tex | sed -n '48,68p'", '/qa/Thesis.tex'), '/qa');
  assert.equal(metadata.fileKey, path.resolve('/qa/Thesis.tex'));
  assert.equal(metadata.range, null);
});

test('relative reads use their actual cwd and do not share command counts across files', () => {
  const guard = createReadProgressGuard({ workspacePath: '/qa' });
  for (let index = 0; index < 8; index += 1) {
    const cwd = path.resolve('/qa', 'chapter' + index);
    const item = { type: 'commandExecution', command: "sed -n '1,240p' main.tex", cwd,
      commandActions: [{ type: 'read', path: 'main.tex' }] };
    assert.equal(extractReadInspection(item, '/qa').fileKey, path.join(cwd, 'main.tex'));
    assert.equal(guard.observe(item).action, 'none');
  }
  assert.equal(extractReadInspection({ ...readItem("sed -n '1,240p' a.tex", '/qa/a.tex'), exitCode: 1 }, '/qa'), null);
  assert.equal(extractReadInspection({ type: 'commandExecution', command: 'cat a.tex b.tex',
    commandActions: [{ type: 'read', path: 'a.tex' }, { type: 'read', path: 'b.tex' }] }, '/qa'), null);
});

test('no abort is counted before steering is acknowledged', async () => {
  let acknowledge;
  const failures = [];
  const controller = createReadProgressController({
    input: { workspacePath: '/qa', readProgressGuardOptions: { minReadCommands: 2, redundantStreak: 1 } },
    getTurn: () => ({ threadId: 'parent', turnId: 'turn' }),
    request: () => new Promise(resolve => { acknowledge = resolve; }),
    fail: error => failures.push(error)
  });
  const item = readItem("sed -n '1,100p' /qa/a.tex", '/qa/a.tex');
  for (let n = 0; n < 8; n += 1) controller.observe(item);
  assert.equal(failures.length, 0);
  acknowledge({});
  await Promise.resolve();
  assert.equal(controller.observe(item), true);
  assert.equal(controller.observe(item), false);
  assert.equal(failures[0].code, 'codex_no_usable_result');
});

test('a completed edit starts fresh coverage and ignores an obsolete steering acknowledgement', async () => {
  const acknowledgements = [];
  const failures = [];
  const controller = createReadProgressController({
    input: { workspacePath: '/qa', readProgressGuardOptions: { minReadCommands: 2, redundantStreak: 1 } },
    getTurn: () => ({ threadId: 'parent', turnId: 'turn' }),
    request: () => new Promise(resolve => acknowledgements.push(resolve)),
    fail: error => failures.push(error)
  });
  const item = readItem("sed -n '1,100p' /qa/a.tex", '/qa/a.tex');
  controller.observe(item); controller.observe(item);
  controller.observe({ type: 'fileChange', status: 'completed' });
  acknowledgements[0]({});
  await Promise.resolve();
  controller.observe(item); controller.observe(item);
  for (let n = 0; n < 4; n += 1) controller.observe(item);
  assert.equal(acknowledgements.length, 2);
  assert.equal(failures.length, 0);
  acknowledgements[1]({});
  await Promise.resolve();
  controller.observe(item); controller.observe(item);
  assert.equal(failures.length, 1);
});

test('parent result, control identity and progress ignore foreign thread and turn notifications', async t => {
  const fixture = createScenarioFixture(t, 'mixed');
  const events = [];
  const controls = [];
  const result = await runCodexAppServerSession({
    ...fixture.input, emit: event => events.push(event),
    onControlReady: control => controls.push({ threadId: control.threadId, turnId: control.turnId })
  });
  assert.equal(result.threadId, 'parent-thread');
  assert.equal(result.assistantMessage, 'PARENT_DONE');
  assert.deepEqual(controls, [{ threadId: 'parent-thread', turnId: 'parent-turn' }]);
  assert.equal(events.some(event => event.type.startsWith('codex.no_progress.')), false);
  assert.equal(JSON.stringify(events).includes('CHILD_MUST_NOT_LEAK'), false);
  assert.match(fs.readFileSync(path.join(fixture.root, 'events.log'), 'utf8'), /active-child-approval:accept/);
});

test('an acknowledged guard failure interrupts and reaps its process group before rejecting', async t => {
  const fixture = createScenarioFixture(t, 'guard-stop');
  const events = [];
  await assert.rejects(runCodexAppServerSession({ ...fixture.input, emit: event => events.push(event) }),
    { code: 'codex_no_usable_result' });
  const log = fs.readFileSync(path.join(fixture.root, 'events.log'), 'utf8');
  assert.match(log, /interrupt:parent-thread:parent-turn/);
  assert.equal(fs.existsSync(path.join(fixture.root, 'late-write.tex')), false);
  assert.equal(events.some(event => event.type === 'codex.session.event'
    && event.detail?.params?.delta === 'LATE_OUTPUT'), false);
  const heartbeatPath = path.join(fixture.root, 'heartbeat');
  const before = fs.existsSync(heartbeatPath) ? fs.readFileSync(heartbeatPath, 'utf8') : '';
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.equal(fs.existsSync(heartbeatPath) ? fs.readFileSync(heartbeatPath, 'utf8') : '', before);
});

test('user cancellation takes the same bounded stop path without accepting late writes', async t => {
  const fixture = createScenarioFixture(t, 'cancel');
  const controller = new AbortController();
  const reason = Object.assign(new Error('user cancelled'), { code: 'codex_cancelled' });
  await assert.rejects(runCodexAppServerSession({
    ...fixture.input, signal: controller.signal,
    onControlReady: () => controller.abort(reason), emit() {}
  }), { code: 'codex_cancelled' });
  assert.equal(fs.existsSync(path.join(fixture.root, 'late-write.tex')), false);
  assert.match(fs.readFileSync(path.join(fixture.root, 'events.log'), 'utf8'), /interrupt:parent-thread:parent-turn/);
});

test('Windows stop uses the owned PID tree and waits for exit state', async () => {
  const { stopCodexAppServer } = require('../native-host/src/codexSessionTiming');
  const child = { pid: 4321, exitCode: null, signalCode: null, killed: true };
  const calls = [];
  await stopCodexAppServer(child, {
    platform: 'win32', interrupt: async () => calls.push('interrupt'),
    taskkill: async pid => { calls.push(pid); child.exitCode = 1; },
    forceTimeoutMs: 0
  });
  assert.deepEqual(calls, ['interrupt', 4321]);
});

test('a sent signal alone never counts as confirmed process exit', async () => {
  const { stopCodexAppServer } = require('../native-host/src/codexSessionTiming');
  const child = { pid: 4321, exitCode: null, signalCode: null, killed: false,
    kill() { this.killed = true; return true; } };
  await assert.rejects(stopCodexAppServer(child, {
    platform: 'linux', terminateTimeoutMs: 0, forceTimeoutMs: 0
  }), { code: 'codex_process_stop_unconfirmed' });
});

function createScenarioFixture(t, scenario) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-guard-boundary-'));
  const scriptPath = path.join(root, 'server.js');
  fs.writeFileSync(scriptPath, '(' + scenarioServer.toString() + ')(' + JSON.stringify(scenario) + ',' + JSON.stringify(root) + ');');
  const commandPath = path.join(root, process.platform === 'win32' ? 'codex.cmd' : 'codex');
  if (process.platform === 'win32') {
    fs.writeFileSync(commandPath, '@echo off\r\n"' + process.execPath + '" "' + scriptPath + '" %*\r\n');
  } else {
    fs.writeFileSync(commandPath, '#!/usr/bin/env node\nrequire(' + JSON.stringify(scriptPath) + ');\n');
    fs.chmodSync(commandPath, 0o755);
  }
  t.after(() => {
    let pids = [];
    try { pids = JSON.parse(fs.readFileSync(path.join(root, 'pids.json'), 'utf8')); } catch (_error) {}
    for (const pid of pids) {
      if (!Number.isInteger(pid) || pid <= 0) continue;
      try {
        if (process.platform === 'win32') {
          require('node:child_process').spawnSync('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
        } else process.kill(pid, 'SIGKILL');
      } catch (_error) {}
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, input: {
    task: 'isolated guard regression', mode: 'auto', workspacePath: root,
    loadCodexLocalSkills: false, loadCodexOverleafSkills: false,
    env: {
      ...process.env, CODEX_OVERLEAF_ENV_READY: '1', CODEX_OVERLEAF_CODEX_PATH: commandPath,
      CODEX_OVERLEAF_USER_CODEX_HOME: path.join(root, 'user-home'),
      CODEX_OVERLEAF_CODEX_HOME: path.join(root, 'plugin-home'),
      CODEX_OVERLEAF_CODEX_TIMEOUT_MS: '6000'
    }
  } };
}

function scenarioServer(scenario, root) {
  const fs = require('node:fs');
  const path = require('node:path');
  const readline = require('node:readline');
  const { spawn } = require('node:child_process');
  const pids = [process.pid];
  const log = text => fs.appendFileSync(path.join(root, 'events.log'), text + '\n');
  const send = message => process.stdout.write(JSON.stringify(message) + '\n');
  const notify = (method, params) => send({ method, params });
  const read = (threadId, turnId, index) => notify('item/completed', {
    threadId, turnId, item: { id: 'read-' + index, type: 'commandExecution', status: 'completed',
      command: "sed -n '1,240p' Thesis.tex", cwd: root,
      commandActions: [{ type: 'read', path: 'Thesis.tex' }] }
  });
  const late = () => {
    notify('item/agentMessage/delta', { threadId: 'parent-thread', turnId: 'parent-turn', itemId: 'late', delta: 'LATE_OUTPUT' });
    send({ id: 900, method: 'item/fileChange/requestApproval', params: { threadId: 'parent-thread', turnId: 'parent-turn' } });
  };
  fs.writeFileSync(path.join(root, 'pids.json'), JSON.stringify(pids));
  process.on('SIGTERM', () => {
    if (scenario === 'mixed') process.exit(0);
    log('SIGTERM'); late();
  });
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', line => {
    const message = JSON.parse(line);
    if (message.id === 900 && message.result) {
      log('late-approval:' + message.result.decision);
      if (message.result.decision === 'accept') fs.writeFileSync(path.join(root, 'late-write.tex'), 'unexpected');
      return;
    }
    if (message.id === 700 && message.result) {
      log('active-child-approval:' + message.result.decision);
      notify('item/agentMessage/delta', { itemId: 'root-answer', delta: 'PARENT_DONE' });
      notify('turn/completed', { threadId: 'parent-thread', turn: { id: 'parent-turn', status: 'completed' } });
      return;
    }
    if (!message.id || !message.method) return;
    if (message.method === 'thread/start' || message.method === 'thread/resume') {
      send({ id: message.id, result: { thread: { id: 'parent-thread' } } }); return;
    }
    if (message.method === 'turn/start') {
      send({ id: message.id, result: { turn: { id: 'parent-turn' } } });
      notify('turn/started', { threadId: 'parent-thread', turn: { id: 'parent-turn' } });
      if (scenario === 'mixed') {
        for (let i = 0; i < 8; i += 1) read('child-' + i, 'child-turn-' + i, i);
        notify('item/started', { threadId: 'child-1', turnId: 'child-turn-1', item: { id: 'child-answer', type: 'agentMessage' } });
        notify('item/agentMessage/delta', { itemId: 'child-answer', delta: 'CHILD_MUST_NOT_LEAK' });
        notify('turn/started', { threadId: 'child-1', turn: { id: 'child-turn-1' } });
        notify('turn/completed', { threadId: 'child-1', turn: { id: 'child-turn-1', status: 'completed' } });
        notify('turn/started', { threadId: 'parent-thread', turn: { id: 'stale-turn' } });
        notify('turn/completed', { threadId: 'parent-thread', turn: { id: 'stale-turn', status: 'completed' } });
        send({ id: 700, method: 'item/fileChange/requestApproval', params: { threadId: 'child-1', turnId: 'child-turn-1' } });
      } else if (scenario === 'guard-stop') {
        const heartbeat = path.join(root, 'heartbeat');
        const child = spawn(process.execPath, ['-e',
          "const fs=require('node:fs');process.on('SIGTERM',()=>{});setInterval(()=>fs.appendFileSync(process.argv[1],'x'),20);", heartbeat
        ], { stdio: 'ignore' });
        pids.push(child.pid);
        fs.writeFileSync(path.join(root, 'pids.json'), JSON.stringify(pids));
        for (let i = 0; i < 6; i += 1) read('parent-thread', 'parent-turn', i);
      }
      return;
    }
    if (message.method === 'turn/steer') {
      send({ id: message.id, result: {} });
      setTimeout(() => { read('parent-thread', 'parent-turn', 7); read('parent-thread', 'parent-turn', 8); }, 5);
      return;
    }
    if (message.method === 'turn/interrupt') {
      log('interrupt:' + message.params.threadId + ':' + message.params.turnId);
      send({ id: message.id, result: {} }); late(); return;
    }
    send({ id: message.id, result: message.method === 'skills/list' ? { data: [] } : {} });
  });
}
