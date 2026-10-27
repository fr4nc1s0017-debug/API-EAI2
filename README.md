# WebEAI | API (Node.js independiente)

Esta carpeta contiene **solo el servidor API**, sin los archivos de la web. Está preparada para despliegue como **Web Service Node.js** en Render y para usarse con el firmware `fase6_wifi_api_mejorado.ino` existente. No requiere librerías NPM externas.

## Publicar API en Render

1. Extrae este ZIP y sube **su contenido** a un repositorio GitHub propio, separado del de la web.
2. En Render crea **New > Web Service**, conecta el repositorio y configura:
   - Runtime: `Node`
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Health Check Path: `/health`
   - Root Directory: vacío
3. En **Environment**, introduce:
   - `DEVICE_API_KEY`: valor idéntico a `API_KEY` del Arduino; **no lo publiques en GitHub**.
   - `ADMIN_API_KEY`: clave distinta y segura usada por el panel web.
   - `CORS_ORIGINS`: URL HTTPS exacta de la web publicada, por ejemplo `https://webeai-web.onrender.com` (sin slash final). Puedes añadirla después de desplegar la web.
   - `DATA_FILE` (opcional): `./data/estado.json`.
4. Despliega y abre `https://TU-API.onrender.com/health`. Debe responder `{"status":"ok","servicio":"api-eai-js"}`.
5. En la web, escribe `https://TU-API.onrender.com/api` y la `ADMIN_API_KEY` en **CONFIGURACIÓN DE LA API**.
6. Revisa que `API_HOST` del firmware apunte al **dominio de esta API** (solo el host, sin `https://` ni `/api`).

Alternativamente puedes usar el `render.yaml` como Blueprint. No crees dos servicios por error.

## Endpoints

| Ruta | Método | Autenticación | Función |
| --- | --- | --- | --- |
| `/health` | GET | ninguna | Estado de la API |
| `/api/estado` | POST | `x-api-key: DEVICE_API_KEY` | Arduino envía telemetría y recibe comando |
| `/api/distancia` | GET | `x-admin-key: ADMIN_API_KEY` | Panel obtiene distancia, motor, modo y conexión |
| `/api/comando` | POST | `x-admin-key: ADMIN_API_KEY` | Encola `{ "accion": "derecha" }`, `"izquierda"` o `"detener"` |
| `/api/modo` | POST | `x-admin-key: ADMIN_API_KEY` | Encola `{ "modo": "automatico" }` o `"manual"` |
| `/api/comandos` | GET | `x-admin-key: ADMIN_API_KEY` | Historial de órdenes |
| `/api/historial?limite=30` | GET | `x-admin-key: ADMIN_API_KEY` | Lecturas recientes |

Payload del Arduino:
```json
{"distancia":28.4,"modo":"manual","motor":"detenido"}
```
Respuesta al Arduino: `{"comando":null}` o `{"comando":"izquierda"}` (según la orden disponible).

## Probar localmente

Instala Node.js 20 o superior. En la carpeta de la API crea un `.env` a partir de `.env.example`, **sustituye los valores de ejemplo** y ejecuta:

```bash
npm test
npm start
```

Visita `http://localhost:3000/health`. Para una web en `http://localhost:8080` configura `CORS_ORIGINS=http://localhost:8080`.

## Seguridad y persistencia

- `DEVICE_API_KEY` y `ADMIN_API_KEY` son **diferentes** y solo se configuran en variables de entorno del servicio API. Nunca coloques estas claves en archivos versionados.
- La API solo permite CORS desde los orígenes listados en `CORS_ORIGINS`. Sin esa variable, un panel alojado en otro dominio no podrá consultar la API desde el navegador.
- Los comandos de movimiento caducan y el dispositivo debe comunicarse recientemente para aceptarlos. No sustituye a una parada física local.
- El historial se almacena en `DATA_FILE` mediante archivo JSON. En Render sin disco persistente **se pierde al reiniciar o redesplegar**; para historial duradero, usa un almacenamiento persistente.
- Si el servicio gratuito entra en reposo, el primer acceso puede tardar en responder y el panel podría mostrar temporalmente el Arduino como desconectado.
