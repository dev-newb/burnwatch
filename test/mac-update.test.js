'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const source = fs.readFileSync(path.join(__dirname, '../tools/mac/update.sh'), 'utf8');

test('Mac updater signs by hash and refuses failed or unexpected signatures', { skip: process.platform === 'win32' }, () => {
  const fn = source.match(/sign_update_bundle\(\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(fn);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-r08-'));
  try {
    for (const mode of ['ok', 'sign-fails', 'wrong-authority', 'verify-fails']) {
      const log = path.join(scratch, mode);
      const script = `
        codesign() {
          printf '%s\\n' "$*" >> "$CODEX_TEST_LOG"
          case "$1" in
            --force) [ "$CODEX_TEST_MODE" != sign-fails ] ;;
            -dvv)
              if [ "$CODEX_TEST_MODE" = wrong-authority ]; then
                printf '%s\\n' 'Signature=adhoc'
              else
                printf '%s\\n' 'Authority=Apple Development: rmcquail@gmail.com (7K7LZM5SAP)'
              fi ;;
            --verify) [ "$CODEX_TEST_MODE" != verify-fails ] ;;
            *) return 99 ;;
          esac
        }
        git() { return 99; }
        ${fn}
        sign_update_bundle 'scratch app.app'
      `;
      const result = spawnSync('/bin/bash', ['-c', script], {
        encoding: 'utf8', env: { ...process.env, CODEX_TEST_MODE: mode, CODEX_TEST_LOG: log }
      });
      assert.equal(result.status, mode === 'ok' ? 0 : 1, result.stderr);
      assert.match(fs.readFileSync(log, 'utf8'), /--sign 6414A85D915F112D91B0BE476AA9F1F735F165BE scratch app\.app/);
    }
    assert.ok(source.indexOf('sign_update_bundle "$built"') < source.indexOf('rm -rf "$APP_DEST"'));
    assert.match(source, /sign_update_bundle "\$built" \|\| \{[\s\S]*?exit 1/);
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
});
