'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { parseVersion, compareVersions, allowsPrerelease, selectRelease, checkForUpdate, getGithubJson } = require('../src/release-check');
const release = (tag_name, options = {}) => ({tag_name, draft: false, prerelease: tag_name.includes('-'), ...options});

test('semantic version ordering handles RC numbers, stable promotion and build metadata', () => {
  const sequence = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2',
    '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0-rc.9', '1.0.0-rc.10', '1.0.0', '1.0.1', '2.0.0'];
  for (let i = 1; i < sequence.length; i++) {
    assert.equal(compareVersions(sequence[i], sequence[i - 1]), 1);
    assert.equal(compareVersions(sequence[i - 1], sequence[i]), -1);
  }
  assert.equal(compareVersions('v2.7.0+build.1', '2.7.0+build.99'), 0);
  assert.equal(compareVersions('2.7.0-rc.9007199254740993', '2.7.0-rc.9007199254740992'), 1);
  for (const version of ['v', '1.2', '1.2.3.4', '01.2.3', '1.2.3-rc.01', '1.2.3-', '1.2.3+']) assert.equal(parseVersion(version), null);
});
test('stable and prerelease channels choose the greatest eligible version, ignoring draft order', () => {
  const releases = [release('2.6.9'), release('2.7.0-rc.2'), release('2.7.0-rc.10'), release('3.0.0', {draft: true}), release('broken')];
  assert.equal(selectRelease(releases, '2.7.0-rc.1').tag_name, '2.7.0-rc.10');
  assert.equal(selectRelease(releases, '2.6.0').tag_name, '2.6.9');
  assert.equal(selectRelease(releases, '2.7.0'), null);
  releases.push(release('2.7.0'));
  assert.equal(selectRelease(releases, '2.7.0-rc.10').tag_name, '2.7.0');
  assert.equal(allowsPrerelease('2.7.0+local'), false);
  assert.equal(allowsPrerelease('2.7.0-rc.1+local'), true);
});
test('stable checks use latest; RC checks paginate to find candidates hidden behind older backports', async () => {
  const paths = [];
  const getJson = async path => {
    paths.push(path);
    if (path.endsWith('/latest')) return release('2.6.0');
    if (path.endsWith('page=1')) return Array.from({length: 100}, () => release('2.6.0'));
    return [release('2.7.0-rc.10')];
  };
  const options = {owner: 'owner', repo: 'repo', getJson};
  assert.deepEqual(await checkForUpdate({...options, current: '2.5.0'}), {hasUpdate: true, version: '2.6.0', tag: '2.6.0'});
  assert.deepEqual(await checkForUpdate({...options, current: '2.7.0-rc.9'}), {hasUpdate: true, version: '2.7.0-rc.10', tag: '2.7.0-rc.10'});
  assert.deepEqual(paths, ['/repos/owner/repo/releases/latest', '/repos/owner/repo/releases?per_page=100&page=1', '/repos/owner/repo/releases?per_page=100&page=2']);
});
test('failed or incomplete checks report an error rather than claiming up to date', async () => {
  for (const getJson of [async () => {throw new Error('HTTP 403');}, async () => ({}), async () => null]) {
    const result = await checkForUpdate({current: '2.7.0', owner: 'owner', repo: 'repo', getJson});
    assert.equal(result.error, true);
  }
  const result = await checkForUpdate({current: '2.7.0-rc.1', owner: 'owner', repo: 'repo',
    getJson: async () => Array.from({length: 100}, () => release('2.6.0'))});
  assert.equal(result.error, true);
});
test('HTTP failures, malformed JSON and timeouts reject; valid JSON resolves', async () => {
  for (const mode of ['success', 'http-error', 'invalid', 'timeout', 'aborted']) {
    let destroyed = false;
    const request = (options, callback) => {
      assert.equal(options.hostname, 'api.github.com');
      const req = new EventEmitter();
      req.destroy = () => { destroyed = true; };
      req.end = () => queueMicrotask(() => {
        if (mode === 'timeout') return req.emit('timeout');
        const res = new EventEmitter(); res.statusCode = mode === 'http-error' ? 403 : 200;
        callback(res);
        if (mode === 'aborted') return res.emit('aborted');
        res.emit('data', mode === 'invalid' ? 'bad' : '{"tag_name":"v2.7.0"}');
        res.emit('end');
      });
      return req;
    };
    if (mode === 'success') assert.deepEqual(await getGithubJson('/releases', request), {tag_name: 'v2.7.0'});
    else await assert.rejects(getGithubJson('/releases', request));
    if (mode === 'timeout') assert.equal(destroyed, true);
  }
});
test('release publishing and checking use the actual repository', () => {
  const pkg = require('../package.json');
  const {owner, repo} = pkg.build.publish[0];
  assert.equal(pkg.repository.url, `https://github.com/${owner}/${repo}.git`);
});
