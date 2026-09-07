'use strict';
const https = require('https');

function parseVersion(value) {
  if (typeof value !== 'string') return null;
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(value);
  if (!match) return null;
  const prerelease = match[4] ? match[4].split('.') : [];
  if (prerelease.some(part => /^0\d+$/.test(part))) return null;
  return { core: match.slice(1, 4), prerelease };
}

function compareNumeric(a, b) {
  return a.length !== b.length ? Math.sign(a.length - b.length) : a === b ? 0 : a > b ? 1 : -1;
}
function compareVersions(a, b) {
  const left = parseVersion(a); const right = parseVersion(b);
  if (!left || !right) throw new Error('Invalid release version');
  for (let i = 0; i < 3; i++) {
    const order = compareNumeric(left.core[i], right.core[i]);
    if (order) return order;
  }
  const l = left.prerelease; const r = right.prerelease;
  if (!l.length || !r.length) return l.length === r.length ? 0 : l.length ? -1 : 1;
  for (let i = 0; i < Math.max(l.length, r.length); i++) {
    if (l[i] === undefined || r[i] === undefined) return l[i] === undefined ? -1 : 1;
    if (l[i] === r[i]) continue;
    const ln = /^\d+$/.test(l[i]); const rn = /^\d+$/.test(r[i]);
    if (ln && rn) return compareNumeric(l[i], r[i]);
    if (ln !== rn) return ln ? -1 : 1;
    return l[i] > r[i] ? 1 : -1;
  }
  return 0;
}
const allowsPrerelease = version => !!parseVersion(version)?.prerelease.length;

function selectRelease(releases, current) {
  if (!parseVersion(current)) throw new Error('Invalid installed version');
  let selected = null;
  for (const release of releases) {
    const version = parseVersion(release?.tag_name);
    if (release?.draft || !version) continue;
    if (!allowsPrerelease(current) && (release.prerelease || version.prerelease.length)) continue;
    if (compareVersions(release.tag_name, current) > 0 && (!selected || compareVersions(release.tag_name, selected.tag_name) > 0)) selected = release;
  }
  return selected;
}

function getGithubJson(apiPath, request = https.request) {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: 'api.github.com', path: apiPath, method: 'GET', timeout: 5000,
      headers: {'User-Agent': 'claude-usage-widget', Accept: 'application/vnd.github+json'} }, res => {
      let body = '';
      res.on('error', reject);
      res.on('aborted', () => reject(new Error('Release response interrupted')));
      res.on('data', chunk => {
        body += chunk;
        if (body.length > 5 * 1024 * 1024) { reject(new Error('Release response too large')); req.destroy(); }
      });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(Object.assign(new Error(`GitHub HTTP ${res.statusCode}`), {statusCode: res.statusCode}));
        try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { reject(new Error('Release check timeout')); req.destroy(); });
    req.end();
  });
}

async function checkForUpdate({ current, owner, repo, getJson = getGithubJson }) {
  try {
    const base = `/repos/${owner}/${repo}/releases`;
    let releases = [];
    if (allowsPrerelease(current)) {
      // GitHub orders by creation time, not version. Include all pages so a
      // recently backported stable tag cannot hide a newer release candidate.
      for (let page = 1; page <= 10; page++) {
        const batch = await getJson(`${base}?per_page=100&page=${page}`);
        if (!Array.isArray(batch)) throw new Error('Invalid releases response');
        releases.push(...batch);
        if (batch.length < 100) break;
        if (page === 10) throw new Error('Release history exceeds check limit');
      }
    } else {
      const latest = await getJson(`${base}/latest`);
      if (!latest || !parseVersion(latest.tag_name)) throw new Error('Invalid latest release');
      releases = [latest];
    }
    const selected = selectRelease(releases, current);
    return selected ? {hasUpdate: true, version: selected.tag_name.replace(/^v/, ''), tag: selected.tag_name}
      : {hasUpdate: false, version: null};
  } catch { return {hasUpdate: false, version: null, error: true}; }
}
module.exports = { parseVersion, compareVersions, allowsPrerelease, selectRelease, getGithubJson, checkForUpdate };
