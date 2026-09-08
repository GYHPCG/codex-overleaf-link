# Real Chrome UI regressions

Run `node scripts/serve-ui-regression.mjs` from the repository root, then open
`http://127.0.0.1:43187/test/browser/p2-click-and-repaint.html` in Chrome.
Set `PORT` to use another local port. The server serves only the fixture and
four production controllers; it does not connect to Overleaf or Native Host.

1. Click the checked OT checkbox with a real browser pointer action. Require
   `OT PASS target=false persisted=false checked=false` after dispatch.
2. Scroll upward within the history. Require `follow=false` in the visible
   reading indicator, then click **Complete run and repaint**.
3. Require `REPAINT PASS`: the same paragraph remains at the same viewport
   offset (within one pixel), and `follow=false` remains in effect.
4. Click **Switch session**. Require `SWITCH PASS`, preserving the established
   bottom-positioning behavior for explicit session changes.

Reload before repeating. Real pointer dispatch is required for the OT case:
calling `element.click()` from page JavaScript can have different microtask
checkpoint ordering and previously produced a misleading pass.

These browser cases complement `test/p2UiRegression.test.js`; they do not
replace a logged-in example-project test or validate writeback/Accept/Undo.
Stop the local server with Ctrl-C after the check.
