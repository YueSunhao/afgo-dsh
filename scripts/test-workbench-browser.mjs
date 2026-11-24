// Offline interaction acceptance using real React, DOM, Fullscreen and ResizeObserver.
// Run: AFGO_BROWSER=/path/to/chromium node scripts/test-workbench-browser.mjs
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';

const out=resolve('out/pr5-review');
await mkdir(out,{recursive:true});
await build({stdin:{contents:"import React from 'react'; import {createRoot} from 'react-dom/client'; export {React,createRoot};",resolveDir:process.cwd()},bundle:true,format:'iife',globalName:'AFGOReact',outfile:out+'/react.js',define:{'process.env.NODE_ENV':'"production"'}});
assert.ok(process.env.AFGO_BROWSER,'set AFGO_BROWSER to a Chromium executable');
const browser=await chromium.launch({executablePath:process.env.AFGO_BROWSER,headless:true});
const page=await browser.newPage({viewport:{width:1280,height:800}});
const errors=[];page.on('pageerror',e=>errors.push(e.message));
// No credentials, platform requests or production compute; images are deterministic fixtures.
await page.route('https://**/*',route=>route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><circle cx="12" cy="12" r="10" fill="#315bce"/></svg>'}));
try {
  await page.setContent('<html><head><style>html,body{margin:0;height:100%;font-family:sans-serif}#main{height:calc(100vh - 40px);display:flex;flex-direction:column}#sidebar{height:40px;display:flex}</style></head><body><div id="sidebar"></div><div id="main"></div></body></html>');
  await page.addScriptTag({path:out+'/react.js'});
  await page.evaluate(()=>{
    window.__ModuleLoader__={load:def=>{window.plugin=def.factory(()=>AFGOReact.React);}};
  });
  await page.addScriptTag({content:await readFile('lib/client.js','utf8')});
  await page.evaluate(async()=>{
    const {React,createRoot}=AFGOReact, entries=new Map();
    window.actions=[];let saved=false;
    const data={configured:false,writable:true,baseUrl:'https://example.invalid/api',env:{label:'测试环境',host:'example.invalid'}};
    const service={dispatch:async input=>{
      actions.push(input.action);
      let value;
      switch(input.action){
        case 'connection':value={ok:true,data:{...data,configured:saved}};break;
        case 'connect':saved=true;value={ok:true,data:{id:'test-account',name:'测试账号',tier:'trial'}};break;
        case 'tasks':value={ok:true,data:{items:[],total:0,page:1,perPage:20,pages:0,hasMore:false}};break;
        case 'catalog':value={ok:true,data:{fetchedAt:new Date().toISOString(),counts:{kit:1,agent:0},entries:[{name:'DSSP',displayName:'DSSP',type:'kit',version:'1.0.1',icon:'https://galileo.obs.cn-north-4.myhuaweicloud.com/toolbox-icons/prod/DSSP/1.0.1/icon.svg',description:'结构分析测试',tags:[]}]}};break;
        default:value={ok:false,error:{code:'test_only',message:'测试未配置此操作'}};
      }
      return {ok:true,value};
    }};
    const ui={layout:{},locale:{register:(_,d)=>{window.copy=d.zh;return()=>{};},bind:()=>key=>copy[key]},slots:{inject:(_,fn)=>fn(),register:(seat,c)=>{entries.set(seat.name,c);return()=>entries.delete(seat.name);}}};
    await plugin.apply({...ui,remote:{$mount:async()=>{}},get:name=>name==='remote.afgoWorkbench'?service:undefined,effect:f=>f(),inject:(_,fn)=>fn(ui)});
    window.seats=[...entries.keys()];
    createRoot(document.getElementById('sidebar')).render(React.createElement('button',{id:'open-workbench',onClick:()=>createRoot(document.getElementById('main')).render(React.createElement(entries.get('main')))},'星使智算',React.createElement(entries.get('sidebar.panellist'),{size:18})));
  });
  assert.deepEqual(await page.evaluate(()=>seats.sort()),['main','sidebar.panellist','tool.call.toolview']);
  await page.locator('#open-workbench').click();
  await page.getByPlaceholder('粘贴你的 API Key').waitFor();
  assert.deepEqual(await page.evaluate(()=>actions),['connection']);
  await page.getByRole('button',{name:'连接账号',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'请粘贴 API Key'}).waitFor();
  assert.deepEqual(await page.evaluate(()=>actions),['connection']);
  const full=page.locator('.afgo2-fullscreen');
  await full.click();
  await page.waitForFunction(()=>document.fullscreenElement?.classList.contains('afgo2-workbench'));
  await page.waitForFunction(()=>document.querySelector('.afgo2-fullscreen').getAttribute('aria-pressed')==='true');
  assert.equal(await full.getAttribute('aria-pressed'),'true');
  await page.screenshot({path:out+'/fullscreen.png'});
  // Chromium headless may not handle system Escape; exercise the browser's native exit API.
  await page.evaluate(()=>document.exitFullscreen());
  await page.waitForFunction(()=>document.fullscreenElement===null);
  await page.waitForFunction(()=>document.querySelector('.afgo2-fullscreen').getAttribute('aria-pressed')==='false');
  assert.equal(await full.getAttribute('aria-pressed'),'false');
  await page.setViewportSize({width:600,height:800});
  await page.waitForSelector('.afgo2-workbench[data-compact]');
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.waitForFunction(()=>{const n=document.querySelector('[data-afgo-body]');return parseFloat(n.style.getPropertyValue('--afgo-body-height'))===Math.round(n.clientHeight);});
  const height=await page.locator('[data-afgo-body]').evaluate(n=>({actual:n.clientHeight,css:parseFloat(n.style.getPropertyValue('--afgo-body-height'))}));
  assert.equal(height.css,height.actual);
  await page.screenshot({path:out+'/first-run-narrow.png'});
  await page.getByPlaceholder('粘贴你的 API Key').fill('offline-test-only');
  await page.getByRole('button',{name:'验证并保存',exact:true}).click();
  await page.getByRole('tab',{name:'我的任务',exact:true}).waitFor();
  assert.equal(await page.locator('input[type=password]').count(),0);
  await page.getByRole('tab',{name:'发现工具',exact:true}).click();
  await page.locator('.afgo2-tool-mark img').first().waitFor();
  assert.ok((await page.locator('.afgo2-tool-mark img').first().getAttribute('src')).includes('/toolbox-icons/'));
  await page.setViewportSize({width:1280,height:800});
  await page.waitForFunction(()=>!document.querySelector('.afgo2-workbench').hasAttribute('data-compact'));
  await page.screenshot({path:out+'/catalog-wide.png'});
  assert.deepEqual(errors,[]);
  const result={sidebar:true,firstRunNoVerify:true,emptyKeyLocalError:true,connectSwitchesToTasks:true,nativeFullscreen:true,nativeExitSynchronizesButton:true,narrowNoHorizontalOverflow:true,scrollHeightMeasured:true,catalogIcon:true,wideLayoutRestored:true,pageErrors:errors};
  await writeFile(out+'/browser-results.json',JSON.stringify(result,null,2));
  console.log(JSON.stringify(result));
}finally{await browser.close();}
