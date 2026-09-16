'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const builder = import(pathToFileURL(path.join(__dirname, '../scripts/build-content-bundle.mjs')).href);
const esbuildVersion = require('../package.json').devDependencies.esbuild;

function fixture(t) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'col-build-identity-'));
  t.after(() => fs.rmSync(rootDir, { recursive: true }));
  fs.mkdirSync(path.join(rootDir, 'extension/entries'), { recursive: true });
  fs.mkdirSync(path.join(rootDir, 'extension/src/content'), { recursive: true });
  fs.writeFileSync(path.join(rootDir, 'package.json'), JSON.stringify({ devDependencies: { esbuild: esbuildVersion } }));
  fs.writeFileSync(path.join(rootDir, 'extension/entries/content-entry.mjs'), "import '../src/content/probe.js';\n");
  const probe = path.join(rootDir, 'extension/src/content/probe.js');
  fs.writeFileSync(probe, "globalThis.fixtureValue = 'first';\n");
  return { rootDir, probe };
}

function execute(code) {
  const attributes = {};
  const context = { document: { documentElement: { setAttribute(name, value) { attributes[name] = value; } } } };
  vm.runInNewContext(code, context);
  return { attributes, context };
}

test('executed bundle exposes the exact source fingerprint recorded by its build metadata', async t => {
  const { buildContentBundle } = await builder;
  const built = buildContentBundle(fixture(t));
  const result = execute(fs.readFileSync(built.outputPath, 'utf8'));
  assert.match(built.metadata.sourceDigest, /^[a-f0-9]{64}$/);
  assert.equal(result.attributes['data-codex-overleaf-source-digest'], built.metadata.sourceDigest);
  assert.equal(result.context.fixtureValue, 'first');
});

test('build identity and final artifact remain deterministic for unchanged inputs', async t => {
  const { buildContentBundle } = await builder;
  const input = fixture(t);
  const first = buildContentBundle(input).metadata;
  const second = buildContentBundle(input).metadata;
  assert.equal(first.sourceDigest, second.sourceDigest);
  assert.equal(first.outputDigest, second.outputDigest);
});

test('an old executing bundle cannot claim the fingerprint of a newly installed source build', async t => {
  const { buildContentBundle } = await builder;
  const input = fixture(t);
  const first = buildContentBundle(input);
  const oldCode = fs.readFileSync(first.outputPath, 'utf8');
  fs.writeFileSync(input.probe, "globalThis.fixtureValue = 'second';\n");
  const second = buildContentBundle(input);
  assert.notEqual(first.metadata.sourceDigest, second.metadata.sourceDigest);
  assert.equal(execute(oldCode).attributes['data-codex-overleaf-source-digest'], first.metadata.sourceDigest);
  const current = execute(fs.readFileSync(second.outputPath, 'utf8'));
  assert.equal(current.attributes['data-codex-overleaf-source-digest'], second.metadata.sourceDigest);
  assert.equal(current.context.fixtureValue, 'second');
});

test('source fingerprint diagnostics do not require a document in non-browser evaluation', async t => {
  const { buildContentBundle } = await builder;
  const built = buildContentBundle(fixture(t));
  const context = {};
  vm.runInNewContext(fs.readFileSync(built.outputPath, 'utf8'), context);
  assert.equal(context.fixtureValue, 'first');
});
