const assert = require('node:assert/strict');
const test = require('node:test');
const Creator = require('../extension/src/page/textFileCreator');

function fixture(options = {}) {
  const files = new Map([['main.tex', 'Existing document']]);
  const folders = new Set(options.folders || []);
  const expanded = new Set();
  let selectedFolder = '';
  const clicks = [];
  let parent = '';
  let dialog = null;
  let active = 'main.tex';
  let current = options.current !== false;
  let projectId = 'example';
  class Input {
    get value() { return this.text || ''; }
    set value(value) { this.text = value; }
    getClientRects() { return [{}]; }
    dispatchEvent() {}
  }
  const button = (label, click) => {
    const icon = options.iconLabels ? ({ 'New file': 'note_add', 'New folder': 'create_new_folder' }[label] || '') : '';
    return {
      textContent: icon + label, getAttribute: () => '', getClientRects: () => [{}], click,
      cloneNode() {
        const copy = { textContent: icon + label };
        copy.querySelectorAll = selector => {
          assert.ok(selector.includes('[aria-hidden="true"]'));
          return icon ? [{ remove() { copy.textContent = label; } }] : [];
        };
        return copy;
      }
    };
  };
  const openDialog = folder => {
    const input = new Input();
    const create = button('Create', () => {
      const target = [parent, input.value].filter(Boolean).join('/');
      clicks.push(target);
      if (folder) folders.add(target);
      else files.set(target, options.initialContent || '');
      dialog = null;
      if (options.cancelOnCreate) current = false;
      if (options.navigateOnCreate) projectId = 'another-project';
    });
    dialog = {
      getClientRects: () => [{}],
      querySelectorAll: selector => selector === 'button' ? [create] : [input]
    };
  };
  const uploadInput = {
    files: [],
    dispatchEvent(event) {
      if (event.type !== 'change') return;
      for (const file of this.files) {
        const target = [parent, file.name].filter(Boolean).join('/');
        clicks.push(target);
        files.set(target, file.body);
      }
      if (options.cancelOnCreate) current = false;
    }
  };
  const openUpload = () => {
    const close = button('Cancel', () => { dialog = null; });
    dialog = { getClientRects: () => [{}], innerText: 'Upload files',
      querySelectorAll: selector => selector === 'input[type="file"]' ? [uploadInput]
        : selector === 'button' ? [close] : [] };
  };
  const toolbar = {
    querySelectorAll: () => [button('New folder', () => openDialog(true)), button('New file', () => openDialog(false)),
      button('Upload', openUpload), ...(options.duplicateCreate ? [button('Upload', openUpload)] : [])]
  };
  const nativeFolderList = base => {
    const children = [];
    for (const folderPath of folders) {
      if (folderPath.split('/').slice(0, -1).join('/') !== base) continue;
      const toggle = () => expanded.has(folderPath) ? expanded.delete(folderPath) : expanded.add(folderPath);
      const control = { click() {
        parent = folderPath;
        selectedFolder = folderPath;
        if (options.collapsibleFolders) toggle();
      } };
      const arrow = { click: toggle };
      const childGroup = nativeFolderList(folderPath);
      const isExpanded = !options.collapsibleFolders || expanded.has(folderPath);
      children.push({
        getAttribute: name => ({ role: 'treeitem', 'aria-label': folderPath.split('/').pop(),
          'aria-selected': selectedFolder === folderPath ? 'true' : 'false',
          'aria-expanded': isExpanded ? 'true' : 'false' }[name] ?? null),
        querySelector: selector => selector === '[data-file-type="folder"]' ? {}
          : selector === '.file-tree-entity-button' ? control
            : selector === '.folder-expand-collapse-button' ? arrow : null,
        nextElementSibling: isExpanded ? childGroup : null,
        matches: () => false
      });
      if (isExpanded) children.push(childGroup);
    }
    return { getAttribute: name => name === 'role' ? 'tree' : null,
      children: [{ classList: { contains: name => name === 'file-tree-folder-list-inner' }, children }] };
  };
  const treeOperations = {
    getProjectId: () => projectId,
    invalidateDomProjectPathCache() {},
    projectPathExists: target => files.has(target) || (!options.nativeFolders && folders.has(target)),
    collectProjectTextPaths: () => Array.from(files.keys()),
    findFileTreeNode: target => files.has(target) || (!options.nativeFolders && folders.has(target)) ? {
      matches: () => true,
      click() { parent = folders.has(target) ? target : target.split('/').slice(0, -1).join('/'); }
    } : null,
    async openFileByPath(target) { active = target; return { ok: files.has(target) }; },
    async waitForActiveEditorText(target) { return { ok: active === target, text: files.get(target) }; }
  };
  const creator = Creator.create({
    window: {
      HTMLInputElement: Input, Event: class { constructor(type) { this.type = type; } },
      File: class { constructor(parts, name) { this.body = parts.join(''); this.name = name; } },
      DataTransfer: class { constructor() { this.files = []; this.items = { add: file => this.files.push(file) }; } },
      setTimeout(callback) { queueMicrotask(callback); },
      CodexOverleafProjectFiles: { isTextProjectPath: target => target.endsWith('.tex') }
    },
    document: {
      querySelectorAll: () => dialog ? [dialog] : [],
      querySelector: selector => options.nativeFolders && selector.includes('file-tree-list-root') ? nativeFolderList('') : toolbar
    },
    treeOperations,
    uploadHelpers: { chooseOverleafFileInput: inputs => inputs[0] || null,
      assignFilesToInput(input, selected) { input.files = selected; } },
    snapshotRouter: { invalidateCache() {}, async fetchProjectZipSnapshot() {
      return { ok: !options.zipUnavailable && !(options.zipFailsAfterUpload && files.size > 1),
        files: [...Array.from(files, ([path, content]) => ({ path, content })),
          ...(options.serverExisting ? [{ path: options.serverExisting, content: 'collaborator content' }] : [])] };
    } },
    readActiveEditorText() { throw new Error('Creation must not read a live editor buffer'); },
    replaceActiveEditorText() { throw new Error('Creation must not write a live editor buffer'); }
  });
  return { files, folders, clicks, selectedFolder: () => selectedFolder,
    prepare: (target, prepareOptions = {}) => creator.prepareUploadParent(target, {
      ...prepareOptions, isCurrent: () => current
    }), create: (target, content) => creator.createFile(
    { path: target, content }, { isCurrent: () => current }
  ) };
}

test('modern text creation uses the native dialog and preserves existing documents', async () => {
  const f = fixture();
  const result = await f.create('new file.tex', 'Exact new content\n');
  assert.equal(result.ok, true);
  assert.equal(result.method, 'overleaf.native-text-upload');
  assert.equal(result.verification, 'overleaf-zip');
  assert.equal(f.files.get('new file.tex'), 'Exact new content\n');
  assert.equal(f.files.get('main.tex'), 'Existing document');
  assert.deepEqual(f.clicks, ['new file.tex']);
});

test('modern text creation creates nested parents and selects each exact folder', async () => {
  const f = fixture();
  const result = await f.create('qa folder/sub/probe.tex', '% QA\n');
  assert.equal(result.ok, true);
  assert.deepEqual(f.clicks, ['qa folder', 'qa folder/sub', 'qa folder/sub/probe.tex']);
  assert.equal(f.files.get('qa folder/sub/probe.tex'), '% QA\n');
  assert.equal(f.files.has('probe.tex'), false);
});

test('native icon text does not obscure the visually-hidden creation labels', async () => {
  const f = fixture({ iconLabels: true });
  assert.equal((await f.create('root.tex', '% root\n')).ok, true);
  assert.equal((await f.create('qa/sub/probe.tex', '% nested\n')).ok, true);
  assert.deepEqual(f.clicks, ['root.tex', 'qa', 'qa/sub', 'qa/sub/probe.tex']);
  assert.equal(f.files.get('qa/sub/probe.tex'), '% nested\n');
  assert.equal(f.files.get('main.tex'), 'Existing document');
});

test('ambiguous accessible creation labels still fail closed', async () => {
  const f = fixture({ iconLabels: true, duplicateCreate: true });
  assert.equal((await f.create('root.tex', '% root\n')).ok, false);
  assert.deepEqual(f.clicks, []);
});

test('native sibling folder lists do not depend on text-path recognition', async () => {
  const f = fixture({ iconLabels: true, nativeFolders: true });
  assert.equal((await f.create('qa/sub/probe.tex', '% native tree\n')).ok, true);
  assert.deepEqual(f.clicks, ['qa', 'qa/sub', 'qa/sub/probe.tex']);
  assert.equal(f.files.get('qa/sub/probe.tex'), '% native tree\n');
});

test('selecting a folder cannot leave its new child hidden behind a collapsed parent', async () => {
  const f = fixture({ iconLabels: true, nativeFolders: true, collapsibleFolders: true });
  assert.equal((await f.create('qa/sub/probe.tex', '% expanded\n')).ok, true);
  assert.equal((await f.create('qa/sub/second.tex', '% still expanded\n')).ok, true);
  assert.deepEqual(f.clicks, ['qa', 'qa/sub', 'qa/sub/probe.tex', 'qa/sub/second.tex']);
  assert.equal(f.files.get('qa/sub/second.tex'), '% still expanded\n');
});

test('modern creation preserves an explicitly empty new file', async () => {
  const f = fixture();
  assert.equal((await f.create('empty.tex', '')).ok, true);
  assert.equal(f.files.get('empty.tex'), '');
});

test('modern creation never overwrites an existing path', async () => {
  const f = fixture();
  assert.equal((await f.create('main.tex', 'replacement')).ok, false);
  assert.equal(f.files.get('main.tex'), 'Existing document');
  assert.deepEqual(f.clicks, []);
});

test('a nonempty active editor is never used when creating another file', async () => {
  const f = fixture({ initialContent: 'Unexpected editor content' });
  const result = await f.create('probe.tex', 'replacement');
  assert.equal(result.ok, true);
  assert.equal(result.changedDocument, true);
  assert.equal(f.files.get('probe.tex'), 'replacement');
  assert.equal(f.files.get('main.tex'), 'Existing document');
});

test('cancellation before mutation cannot create a file', async () => {
  const f = fixture({ current: false });
  assert.equal((await f.create('probe.tex', 'replacement')).ok, false);
  assert.deepEqual(f.clicks, []);
});

test('cancellation after upload is reported unverified and never retries the mutation', async () => {
  const f = fixture({ cancelOnCreate: true });
  const result = await f.create('probe.tex', 'replacement');
  assert.equal(result.ok, false);
  assert.equal(result.changedDocument, true);
  assert.equal(f.files.get('probe.tex'), 'replacement');
  assert.deepEqual(f.clicks, ['probe.tex']);
});

test('text creation fails before mutation when the server ZIP is unavailable', async () => {
  const f = fixture({ zipUnavailable: true });
  assert.equal((await f.create('probe.tex', 'new')).ok, false);
  assert.deepEqual(f.clicks, []);
});

test('a server-only name collision is not overwritten', async () => {
  const f = fixture({ serverExisting: 'probe.tex' });
  assert.equal((await f.create('probe.tex', 'new')).code, 'target_file_already_exists');
  assert.deepEqual(f.clicks, []);
});

test('upload completion without a verified server receipt cannot claim success', async () => {
  const f = fixture({ zipFailsAfterUpload: true });
  const result = await f.create('probe.tex', 'new');
  assert.equal(result.ok, false);
  assert.equal(result.changedDocument, true);
  assert.deepEqual(f.clicks, ['probe.tex']);
});

test('asset parent preparation creates missing native folders only when explicitly requested', async () => {
  const f = fixture({ nativeFolders: true, collapsibleFolders: true, iconLabels: true });
  await assert.rejects(f.prepare('assets/sub'), /unavailable/);
  assert.deepEqual(f.clicks, []);
  await f.prepare('assets/sub', { createMissing: true });
  assert.deepEqual(f.clicks, ['assets', 'assets/sub']);
  assert.equal(f.selectedFolder(), 'assets/sub');
  assert.equal(f.files.get('main.tex'), 'Existing document');
  await f.prepare('assets/sub', { createMissing: true });
  assert.deepEqual(f.clicks, ['assets', 'assets/sub']);
});

test('asset parent creation reuses existing folders without duplicate creation', async () => {
  const f = fixture({ nativeFolders: true, collapsibleFolders: true, folders: ['assets'] });
  await f.prepare('assets/sub', { createMissing: true });
  assert.deepEqual(f.clicks, ['assets/sub']);
  assert.equal(f.selectedFolder(), 'assets/sub');
});

for (const option of ['cancelOnCreate', 'navigateOnCreate']) {
  test(`asset folder preparation stops after ${option} without creating later parents`, async () => {
    const f = fixture({ nativeFolders: true, [option]: true });
    let mutations = 0;
    await assert.rejects(f.prepare('assets/sub', { createMissing: true, onMutation: () => mutations++ }), /changed|cancelled/);
    assert.deepEqual(f.clicks, ['assets']);
    assert.equal(mutations, 1);
  });
}

test('asset parent creation refuses a file collision and unsafe paths', async () => {
  const f = fixture({ nativeFolders: true });
  f.files.set('assets', 'unrelated file');
  await assert.rejects(f.prepare('assets/sub', { createMissing: true }), /exists|appeared/);
  await assert.rejects(f.prepare('../outside', { createMissing: true }), /valid/);
  assert.deepEqual(f.clicks, []);
  assert.equal(f.files.get('assets'), 'unrelated file');
});
