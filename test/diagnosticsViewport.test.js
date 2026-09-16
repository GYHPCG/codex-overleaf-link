const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const { extractFunction } = require('./_helpers/extractFunction');
const source = fs.readFileSync(path.join(__dirname, '../extension/src/content/diagnosticsPanel.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '../extension/styles/panel.css'), 'utf8');

function place({ width, height, anchor, visualViewport, hidden = false }) {
  let closed = 0;
  const button = { getBoundingClientRect: () => anchor, getClientRects: () => hidden ? [] : [anchor] };
  const document = { defaultView: { innerWidth: width, innerHeight: height, visualViewport } };
  const instance = { container: { ownerDocument: document, querySelector: () => button } };
  const element = { hidden: false, style: {}, getBoundingClientRect() { return { width: Number.parseFloat(this.style.width), height: Math.min(380, Number.parseFloat(this.style.maxHeight)) }; } };
  const position = vm.runInNewContext('(' + extractFunction(source, 'positionFloating') + ')', { closeMenu: () => { closed++; }, closeResult: () => { closed++; } });
  position(instance, element, 560);
  return { element, closed };
}

test('diagnostic result uses viewport width even when its sidebar is only 340px wide', () => {
  const { element } = place({ width: 800, height: 600, anchor: { top: 20, bottom: 40, right: 760 } });
  assert.equal(element.style.width, '560px');
  assert.equal(element.style.left, '200px');
  assert.equal(element.style.top, '48px');
});

test('small viewports clamp both axes instead of clipping actions below the screen', () => {
  const { element } = place({ width: 260, height: 180, anchor: { top: 148, bottom: 168, right: 252 } });
  assert.equal(element.style.width, '236px');
  assert.equal(element.style.maxHeight, '156px');
  assert.equal(element.style.left, '12px');
  assert.equal(element.style.top, '12px');
});

test('visual viewport offsets are included when the page is zoomed', () => {
  const { element } = place({ width: 800, height: 600, visualViewport: { width: 320, height: 240, offsetLeft: 100, offsetTop: 50 }, anchor: { top: 245, bottom: 270, right: 380 } });
  assert.equal(element.style.width, '296px');
  assert.equal(element.style.left, '112px');
  assert.equal(element.style.top, '62px');
});

test('closing the sidebar dismisses its detached diagnostic surfaces', () => {
  const result = place({ width: 800, height: 600, anchor: { top: 20, bottom: 40, right: 760 }, hidden: true });
  assert.equal(result.closed, 2);
});

test('confirmation actions have intrinsic height and can wrap long labels', () => {
  const actions = css.match(/#codex-overleaf-panel \.codex-plugin-confirm-actions\s*\{[^}]*\}/)?.[0] || '';
  const button = css.match(/#codex-overleaf-panel \.codex-plugin-confirm-actions button\s*\{[^}]*\}/)?.[0] || '';
  assert.match(actions, /flex-wrap:\s*wrap/);
  assert.match(button, /height:\s*auto/);
  assert.match(button, /white-space:\s*normal/);
  assert.doesNotMatch(button, /height:\s*30px/);
});
