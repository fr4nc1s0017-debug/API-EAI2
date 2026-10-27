'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const {crearServidor} = require('../server.js');

test('API firmware + web end-to-end, validación y seguridad', async t => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(),'eai-test-'));
  const cfg = {deviceKey:'clave-arduino-pruebas',adminKey:'clave-admin-pruebas',file:path.join(folder,'estado.json'),onlineMs:10000,commandTtlMs:12000,corsOrigins:['https://panel.ejemplo.test']};
  const {server,store} = crearServidor(cfg);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=> {await new Promise(resolve=>server.close(resolve));fs.rmSync(folder,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${server.address().port}`;
  const get = async (route,key)=> {
    const resp=await fetch(base+route,{headers:key?{'x-admin-key':key}:{}});
    return {code:resp.status,data:await resp.json()};
  };
  const send = async (route, body, kind='admin')=>{
    const headerName=kind==='device'?'x-api-key':'x-admin-key';
    const headerKey=kind==='device'?cfg.deviceKey:cfg.adminKey;
    const resp=await fetch(base+route,{method:'POST',headers:{'Content-Type':'application/json',[headerName]:headerKey},body:JSON.stringify(body)});
    return {code:resp.status,data:await resp.json()};
  };
  const tele = (distancia=28,modo='manual',motor='detenido') => send('/api/estado',{distancia,modo,motor},'device');

  await t.test('solo API: no se expone frontend, claves ni código de servidor',async()=> {
    for (const ruta of ['/', '/index.html', '/script.js', '/.env', '/server.js']) {
      const response=await fetch(base+ruta);
      assert.equal(response.status,404,`La ruta ${ruta} no debe servirse`);
    }
  });
  await t.test('health y autenticación separada',async()=>{
    assert.equal((await get('/health')).data.status,'ok');
    assert.equal((await get('/api/distancia')).code,401);
    assert.equal((await get('/api/distancia',cfg.deviceKey)).code,401);
    assert.equal((await get('/api/distancia',cfg.adminKey)).code,200);
    const bad=await fetch(base+'/api/estado',{method:'POST',headers:{'Content-Type':'application/json','x-api-key':cfg.adminKey},body:'{}'});
    assert.equal(bad.status,401);
  });
  await t.test('sin Arduino, panel muestra desconectado y comandos 409',async()=>{
    const info=(await get('/api/distancia',cfg.adminKey)).data;
    assert.equal(info.en_linea,false);assert.equal(info.distancia,null);
    assert.equal((await send('/api/comando',{accion:'derecha'})).code,409);
  });
  await t.test('validación estricta',async()=>{
    assert.equal((await send('/api/estado',{distancia:4,modo:'manual'},'device')).code,422);
    assert.equal((await send('/api/estado',{distancia:0,modo:'manual',motor:'detenido'},'device')).code,422);
    assert.equal((await send('/api/comando',{accion:'volar'})).code,422);
    assert.equal((await send('/api/modo',{modo:'hack'})).code,422);
  });
  await t.test('telemetría persistida y validación del panel',async()=>{
    assert.deepEqual((await tele()).data,{comando:null});
    const data=(await get('/api/distancia',cfg.adminKey)).data;
    assert.equal(data.en_linea,true);assert.equal(data.distancia,28);assert.equal(data.modo,'manual');
    assert.equal(data.motor,'detenido');
    assert.ok(fs.existsSync(cfg.file));
  });
  await t.test('orden modo automático, entrega y confirmación por telemetría',async()=>{
    const created=await send('/api/modo',{modo:'automatico'});
    assert.equal(created.code,202);assert.equal(created.data.comando,'automatico');
    assert.equal((await tele(28,'manual','detenido')).data.comando,'automatico');
    assert.equal((await tele(28,'auto','izquierda')).data.comando,null);
    assert.equal((await get('/api/distancia',cfg.adminKey)).data.modo,'automatico');
    assert.equal((await send('/api/comando',{accion:'derecha'})).code,409);
    const history=(await get('/api/comandos',cfg.adminKey)).data.historial;
    assert.equal(history[0].estado,'observado');
  });
  await t.test('DETENER en automático se convierte en manual (firmware)',async()=>{
    const pending=await send('/api/comando',{accion:'detener'});
    assert.equal(pending.code,202);assert.equal(pending.data.comando,'manual');
    assert.equal((await send('/api/modo',{modo:'automatico'})).code,409);
    assert.equal((await tele(28,'auto','izquierda')).data.comando,'manual');
    assert.equal((await tele(28,'manual','detenido')).data.comando,null);
  });
  await t.test('movimientos y reconocimiento de órdenes repetidas',async()=>{
    assert.equal((await send('/api/comando',{accion:'derecha'})).code,202);
    assert.equal((await send('/api/comando',{accion:'izquierda'})).code,409);
    assert.equal((await tele(22,'manual','detenido')).data.comando,'derecha');
    assert.equal((await tele(22,'manual','derecha')).data.comando,null);
    assert.equal((await send('/api/comando',{accion:'derecha'})).code,202);
    assert.equal((await tele(22,'manual','derecha')).data.comando,'derecha');
    assert.equal((await tele(22,'manual','derecha')).data.comando,null);
  });
  await t.test('modo manual cancela comando en cola y comandos expiran',async()=>{
    await send('/api/modo',{modo:'automatico'});
    const manual=await send('/api/modo',{modo:'manual'});
    assert.equal(manual.code,200);assert.equal(manual.data.estado,'ya_aplicado');
    const records=(await get('/api/comandos',cfg.adminKey)).data.historial;
    assert.equal(records[0].estado,'reemplazado');
    await send('/api/comando',{accion:'izquierda'});
    store.state.pendientes.vence=Date.now()-1;
    assert.equal((await tele(15,'manual','detenido')).data.comando,null);
    assert.equal((await get('/api/comandos',cfg.adminKey)).data.historial[0].estado,'expirado');
  });
  await t.test('simula pérdida de comunicación: no se ponen comandos en cola',async()=>{
    store.state.ultimo.ts=Date.now()-20000;
    assert.equal((await send('/api/comando',{accion:'detener'})).code,409);
    assert.equal((await get('/api/distancia',cfg.adminKey)).data.en_linea,false);
  });
  await t.test('CORS limitado a orígenes autorizados',async()=>{
    const ok=await fetch(base+'/api/distancia',{headers:{Origin:'https://panel.ejemplo.test','x-admin-key':cfg.adminKey}});
    assert.equal(ok.headers.get('access-control-allow-origin'),'https://panel.ejemplo.test');
    const no=await fetch(base+'/api/distancia',{headers:{Origin:'https://mal.ejemplo.test','x-admin-key':cfg.adminKey}});
    assert.equal(no.headers.get('access-control-allow-origin'),null);
    const preflight=await fetch(base+'/api/comando',{method:'OPTIONS',headers:{
      Origin:'https://panel.ejemplo.test',
      'Access-Control-Request-Method':'POST',
      'Access-Control-Request-Headers':'content-type,x-admin-key',
    }});
    assert.equal(preflight.status,204);
    assert.equal(preflight.headers.get('access-control-allow-origin'),'https://panel.ejemplo.test');
    const badPreflight=await fetch(base+'/api/comando',{method:'OPTIONS',headers:{
      Origin:'https://mal.ejemplo.test','Access-Control-Request-Method':'POST'
    }});
    assert.equal(badPreflight.status,403);
  });
  await t.test('historial de lecturas y persistencia tras reinicio lógico',async()=>{
    assert.ok((await get('/api/historial?limite=5',cfg.adminKey)).data.lecturas.length >0);
    const {store:nuevo}=crearServidor(cfg);
    assert.equal(nuevo.state.ultimo.distancia,15);
    assert.ok(nuevo.state.comandos.length>=3);
  });
});
