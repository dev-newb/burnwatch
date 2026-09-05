'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  parseWslDistros,
  linuxHomeToUnc,
  discoverCredentialHomes
} = require('../src/local-credential-sources');

test('WSL distribution output is decoded from the UTF-16 format used by wsl.exe', () => {
  const output = Buffer.from('Ubuntu\r\nDebian\r\n', 'utf16le');
  assert.deepEqual(parseWslDistros(output), ['Ubuntu', 'Debian']);
});

test('Linux homes become safe wsl.localhost UNC paths', () => {
  assert.equal(
    linuxHomeToUnc('Ubuntu', '/home/sahar\n'),
    '\\\\wsl.localhost\\Ubuntu\\home\\sahar'
  );
  assert.equal(linuxHomeToUnc('../bad', '/home/sahar'), null);
  assert.equal(linuxHomeToUnc('Ubuntu', '/home/../root'), null);
});

test('credential discovery includes Windows and every usable WSL home', () => {
  const calls = [];
  const spawnSyncImpl = (_command, args) => {
    calls.push(args);
    if (args[0] === '--list') {
      return { status: 0, stdout: Buffer.from('Ubuntu\r\nBroken\r\n', 'utf16le') };
    }
    if (args[1] === 'Ubuntu') return { status: 0, stdout: '/home/sahar\n' };
    return { status: 1, stdout: '' };
  };

  assert.deepEqual(discoverCredentialHomes({
    force: true,
    homedir: 'C:\\Users\\Sahar',
    platform: 'win32',
    pathImpl: path.win32,
    spawnSyncImpl
  }), [
    { id: 'windows', kind: 'windows', home: 'C:\\Users\\Sahar' },
    { id: 'wsl:Ubuntu', kind: 'wsl', distro: 'Ubuntu', home: '\\\\wsl.localhost\\Ubuntu\\home\\sahar' }
  ]);
  assert.equal(calls.length, 3);
});

test('utility distros (docker-desktop and friends) are never probed or offered', () => {
  const probed = [];
  const spawnSyncImpl = (_command, args) => {
    if (args[0] === '--list') {
      return { status: 0, stdout: Buffer.from('docker-desktop\r\nUbuntu\r\ndocker-desktop-data\r\n', 'utf16le') };
    }
    probed.push(args[1]);
    if (args[1] === 'Ubuntu') return { status: 0, stdout: '/home/sahar\n' };
    return { status: 1, stdout: '' };
  };
  const homes = discoverCredentialHomes({ force: true, homedir: 'C:\\U', platform: 'win32', spawnSyncImpl });
  // Probing a utility distro would cold-boot its VM — it must never happen
  assert.deepEqual(probed, ['Ubuntu']);
  assert.deepEqual(homes.map((home) => home.id), ['windows', 'wsl:Ubuntu']);
});
