'use strict';
/**
 * API EAI independiente (Node.js sin dependencias externas).
 * Contrato firmware: POST /api/estado (x-api-key) => { comando: string|null }
 * Contrato web:      GET  /api/distancia, POST /api/comando, POST /api/modo (x-admin-key)
 *
 * Persistencia JSON atómica: 1 proceso Node / 1 instancia. El archivo DATA_FILE
 * requiere un disco persistente si se aloja en Render y se desea conservar historial.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = __dirname;

function cargarEnvLocal(file = path.join(ROOT, '.env')) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z_0-9]*)\s*=\s*(.*?)\s*$/);
    if (!match || Object.hasOwn(process.env, match[1])) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[match[1]] = value;
  }
}

function configurar(vars = process.env) {
  const deviceKey = vars.DEVICE_API_KEY || '';
  const adminKey = vars.ADMIN_API_KEY || '';
  if (!deviceKey || !adminKey || deviceKey === adminKey) {
    throw new Error('Configura DEVICE_API_KEY y ADMIN_API_KEY distintas en .env o variables de entorno');
  }
  return {
    deviceKey, adminKey,
    file: path.resolve(vars.DATA_FILE || path.join(ROOT, 'data', 'estado.json')),
    onlineMs: 10000,
    commandTtlMs: 12000,
    corsOrigins: (vars.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean),
  };
}

const inicial = () => ({version: 1, seq: 0, ultimo: null, pendientes: null, historial: [], comandos: []});

function abrirAlmacen(file) {
  fs.mkdirSync(path.dirname(file), {recursive:true});
  let state = inicial();
  if (fs.existsSync(file)) {
    const content = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (content.version !== 1 || !Array.isArray(content.historial) ||
        !Array.isArray(content.comandos) || !Number.isSafeInteger(content.seq)) {
      throw new Error('Formato DATA_FILE no reconocido');
    }
    state = content;
  }
  function guardar() {
    const temporal = `${file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temporal, JSON.stringify(state), {mode: 0o600});
      fs.renameSync(temporal, file);
    } catch (error) {
      try {fs.unlinkSync(temporal);} catch (_) { /* ignore */ }
      throw error;
    }
  }
  // Un único proceso con escritura síncrona: cada cambio se serializa de forma atómica.
  return {state, guardar};
}

function coincideClave(recibida, esperada) {
  if (typeof recibida !== 'string' || !recibida) return false;
  const a = Buffer.from(recibida, 'utf8');
  const b = Buffer.from(esperada, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function devolver(res, status, data, additional = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control':'no-store',
    'X-Content-Type-Options':'nosniff',
    ...additional,
  });
  res.end(body);
}

function errorHTTP(status, mensaje) {
  const error = new Error(mensaje); error.status = status; return error;
}

async function leerJson(req) {
  if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
    throw errorHTTP(415, 'Se requiere Content-Type: application/json');
  }
  let total = 0;
  const chunks = [];
  for await (const chunk of req) {
    total += chunk.length;
    if (total > 2048) throw errorHTTP(413, 'El JSON excede 2048 bytes');
    chunks.push(chunk);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('JSON debe ser un objeto');
    return parsed;
  } catch (err) {throw errorHTTP(400, 'JSON inválido');}
}

function exactKeys(obj, props) {
  return Object.keys(obj).length === props.length &&
    props.every(p => Object.hasOwn(obj, p));
}

function esTelemetria(d) {
  return exactKeys(d, ['distancia','modo','motor']) &&
    (d.distancia === null || (typeof d.distancia === 'number' && Number.isFinite(d.distancia) && d.distancia >= 2 && d.distancia <= 400)) &&
    ['manual','auto'].includes(d.modo) &&
    ['detenido','derecha','izquierda'].includes(d.motor);
}

function linea(s, now, onlineMs) {
  return Boolean(s.ultimo && now - s.ultimo.ts >= 0 && now - s.ultimo.ts <= onlineMs);
}

function coincideEjecucion(cmd, estado) {
  if (!estado) return false;
  switch (cmd) {
    case 'automatico': return estado.modo === 'auto';
    case 'manual': return estado.modo === 'manual' && estado.motor === 'detenido';
    case 'detener': return estado.modo === 'manual' && estado.motor === 'detenido';
    case 'derecha': return estado.modo === 'manual' && estado.motor === 'derecha';
    case 'izquierda': return estado.modo === 'manual' && estado.motor === 'izquierda';
    default: return false;
  }
}

function cerrarPendiente(store, estado, tiempo) {
  const p = store.state.pendientes;
  if (!p) return false;
  p.estado = estado;
  p.fin = new Date(tiempo).toISOString();
  store.state.comandos.push({...p});
  store.state.comandos = store.state.comandos.slice(-100);
  store.state.pendientes = null;
  return true;
}

function caducar(store, now) {
  if (store.state.pendientes && now >= store.state.pendientes.vence) {
    cerrarPendiente(store, 'expirado', now);
    return true;
  }
  return false;
}

function nuevoComando(store, comando, now) {
  const p = {
    id: ++store.state.seq, comando, estado:'pendiente',
    creado: new Date(now).toISOString(), vence: now + store.config.commandTtlMs,
    entregas:0, enviado:null, fin:null,
  };
  store.state.pendientes = p;
  return p;
}

function crearServidor(cfg) {
  const store = abrirAlmacen(cfg.file);
  store.config = cfg;
  const server = http.createServer(async (req,res) => {
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer');
    try {
      const rawOrigin = req.headers.origin;
      if (rawOrigin && cfg.corsOrigins.includes(rawOrigin)) {
        res.setHeader('Access-Control-Allow-Origin',rawOrigin);
        res.setHeader('Vary','Origin');
        res.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers','Content-Type, X-Admin-Key, X-API-Key');
      }
      const url = new URL(req.url, 'http://localhost');
      const p = url.pathname;
      if (req.method === 'OPTIONS' && p.startsWith('/api/')) {
        res.writeHead(rawOrigin && cfg.corsOrigins.includes(rawOrigin) ? 204 : 403);res.end();return;
      }
      if (req.method === 'GET' && p === '/health') {
        devolver(res,200,{status:'ok',servicio:'api-eai-js'});return;
      }
      if (!p.startsWith('/api/')) {
        throw errorHTTP(404, 'Solo API. La web se despliega como sitio estatico independiente.');
      }
      const esArduino = req.method === 'POST' && p === '/api/estado';
      const auth = esArduino ? req.headers['x-api-key'] : req.headers['x-admin-key'];
      if (!coincideClave(auth, esArduino ? cfg.deviceKey : cfg.adminKey)) {
        throw errorHTTP(401, 'Clave ausente o incorrecta');
      }
      if (url.search && p !== '/api/historial') throw errorHTTP(400,'La ruta no acepta parámetros');
      const now = Date.now();
      if (esArduino) {
        const data = await leerJson(req);
        if (!esTelemetria(data)) throw errorHTTP(422,'Telemetría inválida: distancia, modo y motor son obligatorios');
        caducar(store,now);
        store.state.ultimo = {...data, ts:now, fecha:new Date(now).toISOString()};
        store.state.historial.push(store.state.ultimo);
        store.state.historial = store.state.historial.slice(-300);
        let cmd = null;
        const pending = store.state.pendientes;
        if (pending && pending.entregas > 0 && coincideEjecucion(pending.comando, data)) {
          // ACK inferido por la telemetría posterior. Responder null también
          // libera la deduplicación del firmware para órdenes idénticas futuras.
          cerrarPendiente(store,'observado',now);
        } else if (pending) {
          cmd = pending.comando;
          pending.entregas++;
          pending.enviado = new Date(now).toISOString();
        }
        // Se persiste el estado incluso cuando solo caduca un comando.
        store.guardar();
        devolver(res,200,{comando:cmd}); return;
      }
      if (req.method === 'GET' && p === '/api/distancia') {
        const s=store.state;
        const st=s.ultimo;
        devolver(res,200,{
          distancia: st ? st.distancia : null,
          modo: st && st.modo === 'auto' ? 'automatico':'manual',
          motor: st ? st.motor : 'detenido',
          en_linea:linea(s,now,cfg.onlineMs),
          ultima_actualizacion:st ? st.fecha : null,
          comando_pendiente:s.pendientes && s.pendientes.vence>now ? s.pendientes.comando : null,
        });return;
      }
      if (req.method === 'GET' && p === '/api/comandos') {
        devolver(res,200,{pendiente:store.state.pendientes,historial:store.state.comandos.slice(-30).reverse()});return;
      }
      if (req.method === 'GET' && p === '/api/historial') {
        const n = Number(url.searchParams.get('limite') || 30);
        if (!Number.isInteger(n) || n < 1 || n > 300 || [...url.searchParams.keys()].some(k=>k!=='limite')) {
          throw errorHTTP(400,'limite debe ser entero entre 1 y 300');
        }
        devolver(res,200,{lecturas:store.state.historial.slice(-n).reverse()});return;
      }
      if (req.method === 'POST' && (p === '/api/comando' || p === '/api/modo')) {
        const data = await leerJson(req);
        const esModo = p === '/api/modo';
        const valido = esModo ?
          exactKeys(data,['modo']) && ['manual','automatico'].includes(data.modo) :
          exactKeys(data,['accion']) && ['izquierda','derecha','detener'].includes(data.accion);
        if (!valido) throw errorHTTP(422,esModo ? 'modo debe ser manual o automatico' : 'accion debe ser izquierda, derecha o detener');
        caducar(store,now);
        if (!linea(store.state,now,cfg.onlineMs)) {
          store.guardar();
          throw errorHTTP(409,'Arduino desconectado: no se encolan movimientos antiguos');
        }
        const st=store.state.ultimo;
        let cmd = esModo ? (data.modo==='automatico'?'automatico':'manual') : data.accion;
        // DETENER estando en automático debe emitir manual, porque el firmware
        // ignora la 's' durante el modo AUTO; cambiarModo(MANUAL) detiene motores.
        if (cmd==='detener' && st.modo==='auto') cmd='manual';
        if (['izquierda','derecha'].includes(cmd) && st.modo !== 'manual') {
          throw errorHTTP(409,'Los movimientos manuales solo se permiten en modo manual');
        }
        // No cancelar una detención prioritaria con un cambio inmediato a AUTO.
        if (store.state.pendientes && ['detener','manual'].includes(store.state.pendientes.comando)
            && cmd === 'automatico') {
          throw errorHTTP(409,'Primero debe completarse el comando de parada/manual');
        }
        const privilegio = cmd==='manual' || cmd==='detener';
        if (store.state.pendientes && !esModo && !privilegio) {
          throw errorHTTP(409,'Ya hay una orden en curso; espera a que se confirme');
        }
        if (store.state.pendientes) cerrarPendiente(store,'reemplazado',now);
        // No encolar cambio de modo ya aplicado; sí se permite renovar una
        // orden de movimiento en manual (watchdog de 15 s en Arduino).
        if (esModo && st.modo === (cmd==='automatico'?'auto':'manual')) {
          store.guardar();devolver(res,200,{estado:'ya_aplicado',comando:null,modo:data.modo});return;
        }
        const nuevo=nuevoComando(store,cmd,now);
        store.guardar();
        devolver(res,202,{estado:'pendiente',id:nuevo.id,comando:cmd,
          vigencia_segundos:cfg.commandTtlMs/1000});return;
      }
      throw errorHTTP(404,'Ruta de API desconocida');
    } catch (err) {
      if (err instanceof SyntaxError && err.message.includes('URL')) return devolver(res,400,{error:'URL inválida'});
      if (err.code === 'ENOENT') return devolver(res,404,{error:'No encontrado'});
      if (!err.status) console.error('Error interno:',err.message);
      if (!res.headersSent) devolver(res,err.status || 500,{error:err.status ? err.message : 'Error interno del servidor'});
      else res.destroy();
    }
  });
  return {server, store};
}

if (require.main === module) {
  cargarEnvLocal();
  try {
    const cfg = configurar();
    const port = Number(process.env.PORT || 3000);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT inválido');
    const {server}=crearServidor(cfg);
    server.listen(port,'0.0.0.0',()=> {
      console.log(`API EAI independiente: http://localhost:${port}`);
      console.log('Firmware: POST /api/estado. Panel: GET /api/distancia, POST /api/comando, POST /api/modo.');
    });
  } catch (err) {
    console.error('No se pudo iniciar:',err.message);
    process.exitCode=1;
  }
}
module.exports={crearServidor,configurar,cargarEnvLocal};
