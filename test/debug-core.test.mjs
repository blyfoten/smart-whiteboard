// Plain-Node checks for the debug / bug-fix mode's pure logic:
// debug/bug-report.js (the hand-off contract) and debug/workspace.js (the
// sandbox the coding agent is confined to).
// Run: node test/debug-core.test.mjs
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const report = require('../debug/bug-report.js');
const workspace = require('../debug/workspace.js');
const agent = require('../debug/agent.js');

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`FAIL  ${name}\n      ${err.message}`);
    process.exitCode = 1;
  }
}

async function checkAsync(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`FAIL  ${name}\n      ${err.message}`);
    process.exitCode = 1;
  }
}

// ---- bug report -------------------------------------------------------------

check('slugify produces a git-safe branch segment', () => {
  assert.equal(report.slugify('Undo does NOT restore erased shapes!'), 'undo-does-not-restore-erased');
  assert.equal(report.slugify('   ***   '), 'issue');
  assert.equal(report.slugify(''), 'issue');
  assert.ok(!report.slugify('trailing punctuation ...').endsWith('-'));
  assert.ok(report.slugify('a'.repeat(80)).length <= 32, 'long titles are capped');
});

check('branchNameFor stamps a dated debug branch', () => {
  const branch = report.branchNameFor({ title: 'Plot button dead' }, new Date(2026, 7, 16, 9, 5));
  assert.equal(branch, 'debug/plot-button-dead-0816-0905');
  assert.ok(/^debug\/[a-z0-9-]+$/.test(branch), `not a safe branch name: ${branch}`);
});

check('normalizeBugReport fills in what the model left out', () => {
  const { report: r, warnings } = report.normalizeBugReport({
    title: 'Shapes land in the wrong place',
    summary: 'Circles the assistant draws end up above where I point.',
    area: 'CANVAS',
    severity: 'nonsense',
  });
  assert.equal(r.severity, 'major', 'unknown severity falls back to the default');
  assert.equal(r.area, 'canvas', 'area is normalised to lower case');
  assert.equal(r.actual, r.summary, 'actual defaults to the summary');
  assert.ok(r.suspectedFiles.includes('src/canvas.js'), 'area hints are attached');
  assert.ok(warnings.some((w) => /steps to reproduce/i.test(w)));
  assert.ok(warnings.some((w) => /expected/i.test(w)));
});

check('normalizeBugReport survives junk input', () => {
  const empty = report.normalizeBugReport(null);
  assert.equal(empty.report.title, 'Unnamed issue');
  assert.ok(empty.warnings.length >= 2);
  const listy = report.normalizeBugReport({ summary: 'x', stepsToReproduce: 'one\ntwo\n\nthree' });
  assert.deepEqual(listy.report.stepsToReproduce, ['one', 'two', 'three'], 'newline steps become a list');
});

check('normalizeBugReport derives a title from the summary', () => {
  const { report: r } = report.normalizeBugReport({ summary: 'The undo button does nothing. It used to work.' });
  assert.equal(r.title, 'The undo button does nothing');
});

check('formatBugReport carries the evidence the agent needs', () => {
  const { report: r } = report.normalizeBugReport({
    title: 'Undo is dead',
    summary: 'Undo does nothing after erasing.',
    stepsToReproduce: ['draw a box', 'erase it', 'press undo'],
    expected: 'the box comes back',
    actual: 'nothing happens',
    userQuote: 'undo is broken',
  });
  const text = report.formatBugReport(
    r,
    { url: 'https://board.example/', errors: ['TypeError: x is undefined'], board: '3 objects' },
    { branch: 'debug/undo-is-dead-0816-0905', baseBranch: 'main', commit: 'abc1234', hasScreenshot: true }
  );
  assert.ok(text.includes('# Bug report: Undo is dead'));
  assert.ok(text.includes('1. draw a box'), 'steps are numbered');
  assert.ok(text.includes('debug/undo-is-dead-0816-0905'), 'the working branch is stated');
  assert.ok(text.includes('TypeError: x is undefined'), 'console errors are included verbatim');
  assert.ok(text.includes('> undo is broken'), "the user's own words are quoted");
  assert.ok(text.includes('screenshot'), 'the screenshot is announced');
});

// ---- workspace sandbox ------------------------------------------------------

check('resolveInRepo accepts ordinary repo paths', () => {
  assert.equal(workspace.resolveInRepo('src/voice.js').rel, 'src/voice.js');
  assert.equal(workspace.resolveInRepo('./providers/claude.js').rel, 'providers/claude.js');
  assert.equal(
    workspace.resolveInRepo(path.join(workspace.REPO_ROOT, 'server.js')).rel,
    'server.js',
    'an absolute path inside the repo is accepted'
  );
});

check('resolveInRepo refuses to leave the repository', () => {
  for (const bad of ['../secrets.txt', '../../etc/passwd', '/etc/passwd', 'src/../../outside.js']) {
    assert.throws(() => workspace.resolveInRepo(bad), workspace.WorkspaceError, `allowed escape: ${bad}`);
  }
});

check('resolveInRepo refuses credentials and git internals', () => {
  for (const bad of ['.env', '.env.local', '.git/config', 'node_modules/express/index.js', '.debug-sessions/x.json']) {
    assert.throws(() => workspace.resolveInRepo(bad), workspace.WorkspaceError, `allowed access: ${bad}`);
  }
  assert.equal(workspace.resolveInRepo('.env.example').rel, '.env.example', '.env.example stays readable');
});

check('only the repo\'s own npm tasks can be run', () => {
  ['build', 'test', 'install'].forEach((t) => assert.ok(workspace.isAllowedTask(t), `${t} should be allowed`));
  ['rm', 'curl', 'npm run build; rm -rf /', 'node', ''].forEach((t) =>
    assert.ok(!workspace.isAllowedTask(t), `${t} must not be allowed`));
});

check('searchCode finds real code and respects filePattern', () => {
  const hits = workspace.searchCode('attachVoiceServer', { filePattern: '\\.js$' });
  assert.ok(hits.length > 0, 'expected matches for attachVoiceServer');
  assert.ok(hits.every((h) => /^[\w./-]+\.js:\d+: /.test(h)), 'hits are file:line: text');
  const scoped = workspace.searchCode('attachVoiceServer', { filePattern: 'voice-server\\.js$' });
  assert.ok(scoped.length > 0 && scoped.every((h) => h.startsWith('voice-server.js:')), 'filePattern narrows the search');
  // Built at runtime so the needle is not literally present in this file.
  assert.equal(workspace.searchCode(['zzz', 'absent', Date.now()].join('-')).length, 0);
});

check('readFile returns numbered lines and rejects binaries', () => {
  const res = workspace.readFile('package.json', { startLine: 1, endLine: 3 });
  assert.equal(res.startLine, 1);
  assert.ok(res.content.startsWith('1\t'), 'lines are numbered');
  assert.throws(() => workspace.readFile('public/fonts/caveat-latin.woff2'), workspace.WorkspaceError);
  assert.throws(() => workspace.readFile('src'), workspace.WorkspaceError, 'a directory is not a file');
});

check('editFile demands a unique, existing match', () => {
  const rel = 'test/.tmp-edit-check.txt';
  const abs = path.join(workspace.REPO_ROOT, rel);
  try {
    workspace.writeFile(rel, 'alpha\nbeta\nalpha\n');
    assert.throws(() => workspace.editFile(rel, 'gamma', 'x'), workspace.WorkspaceError, 'missing string must fail');
    assert.throws(() => workspace.editFile(rel, 'alpha', 'x'), workspace.WorkspaceError, 'ambiguous match must fail');
    assert.equal(workspace.editFile(rel, 'alpha', 'x', true).replacements, 2);
    assert.equal(fs.readFileSync(abs, 'utf8'), 'x\nbeta\nx\n');
    assert.equal(workspace.editFile(rel, 'beta', 'gamma').replacements, 1);
    assert.equal(fs.readFileSync(abs, 'utf8'), 'x\ngamma\nx\n');
  } finally {
    fs.rmSync(abs, { force: true });
  }
});

// ---- agent tool loop --------------------------------------------------------

check('trimMessages keeps the briefing and a well-formed tail', () => {
  const messages = [{ role: 'user', content: 'briefing' }];
  for (let i = 0; i < 100; i++) {
    messages.push({ role: 'assistant', content: `a${i}` });
    messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${i}` }] });
  }
  const trimmed = agent.trimMessages(messages, 20);
  assert.equal(trimmed[0].content, 'briefing', 'the bug report is never dropped');
  assert.equal(trimmed[1].role, 'assistant', 'no two user turns in a row, no orphaned tool_result');
  for (let i = 1; i < trimmed.length; i++) {
    assert.notEqual(trimmed[i].role, trimmed[i - 1].role, `roles must alternate at index ${i}`);
  }
  assert.deepEqual(agent.trimMessages(messages.slice(0, 5), 20).length, 5, 'a short transcript is untouched');
});

await checkAsync('agent tools read the repo and report back', async () => {
  const session = { branch: 'debug/test', changedFiles: [], commits: [] };
  const listed = await agent.executeTool('list_files', { path: 'providers' }, session);
  assert.ok(listed.content.includes('providers/catalogue.js'));
  const read = await agent.executeTool('read_file', { path: 'package.json', startLine: 1, endLine: 2 }, session);
  assert.ok(read.content.includes('package.json (lines 1-2'));
  const found = await agent.executeTool('search_code', { pattern: 'attachDebugRoutes' }, session);
  assert.ok(/debug-routes\.js:\d+:/.test(found.content));
  const spoken = await agent.executeTool('notify_user', { message: 'on it' }, session);
  assert.equal(spoken.meta.spoken, 'on it', 'notify_user carries the sentence to the voice channel');
  const unknown = await agent.executeTool('rm_rf', {}, session);
  assert.ok(unknown.content.includes('Unknown tool'));
});

check('truncate caps tool output', () => {
  const long = 'x'.repeat(50000);
  const short = workspace.truncate(long, 100);
  assert.ok(short.length < 200);
  assert.ok(short.includes('truncated'));
  assert.equal(workspace.truncate('fine', 100), 'fine');
});

console.log(`\n${passed} check(s) passed.`);
