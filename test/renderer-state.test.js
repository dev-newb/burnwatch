'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const renderer = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');

test('adoption changes refresh the canonical settings cache for toggles and offers', async () => {
  let state = {openai:true,google:false};
  const ctx = vm.createContext({window:{_cachedSettings:{cliAdopted:{...state}},electronAPI:{
    setCliAdopted:async(provider,adopted)=>({ok:true,state:state={...state,[provider]:adopted}})
  }}});
  vm.runInContext(renderer.match(/async function updateCliAdoption\([\s\S]*?\n}/)[0],ctx);
  await ctx.updateCliAdoption('openai',false);
  assert.equal(ctx.window._cachedSettings.cliAdopted.openai,false);
  await ctx.updateCliAdoption('google',true);
  assert.equal(ctx.window._cachedSettings.cliAdopted.google,true);
  assert.equal(ctx.window._cachedSettings.cliAdopted.openai,false);
  ctx.window.electronAPI.setCliAdopted=async()=>({ok:false});
  await assert.rejects(ctx.updateCliAdoption('openai',true));
  assert.equal(ctx.window._cachedSettings.cliAdopted.openai,false);
});

test('Electron settings form cannot overwrite backend adoption', () => {
  const main = fs.readFileSync(path.join(__dirname,'../main.js'),'utf8');
  const start=main.indexOf("ipcMain.handle('save-settings'");
  const end=main.indexOf('\n});',start);
  assert.doesNotMatch(main.slice(start,end),/store\.(?:set|delete)\(['"]settings\.cliAdopted/);
  assert.doesNotMatch(main.slice(start,end),/store\.set\(['"]settings['"]/);
});

test('first OAuth connection refreshes credentials before fetching and starts polling', async () => {
  const start=renderer.indexOf('    const runConnect = async');
  const end=renderer.indexOf('    const wireConnect =',start);
  for (const provider of ['openai','google']) {
    for (const overlay of ['none','flex']) {
      const calls=[];
      const ctx=vm.createContext({credentials:{loggedIn:false},
        elements:{settingsOverlay:{style:{display:overlay}}},
        window:{electronAPI:{
          oauthConnect:async p=>{assert.equal(p,provider);return {ok:true};},
          getCredentials:async()=>{calls.push('credentials');return {providerFallbackAvailable:true};}
        }},
        fetchUsageData:async()=>{assert.equal(ctx.credentials.providerFallbackAvailable,true);calls.push('fetch');},
        loadSettings:async()=>calls.push('settings'),startAutoUpdate:()=>calls.push('poll')
      });
      vm.runInContext(renderer.slice(start,end)+'\nglobalThis.runConnect=runConnect;',ctx);
      await ctx.runConnect(provider);
      assert.deepEqual(calls,overlay==='none'?['credentials','fetch','poll']:['credentials','fetch','settings','poll']);
    }
  }
});
