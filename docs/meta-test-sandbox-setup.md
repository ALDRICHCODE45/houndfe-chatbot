# Preparación privada del número de prueba Meta

**No inicia un servicio ni envía mensajes.** Esta guía solo prepara credenciales locales para ensayar el canal WhatsApp del cliente. El flujo humano objetivo se resuelve en el POS, **no** con un segundo operador por WhatsApp.

## Lo que debe hacer el dueño

1. En Meta Developers → WhatsApp → API Setup, confirmar que el destinatario **cliente** figura verificado. Un solo destinatario basta para el canal del cliente.
2. Obtener desde la app de prueba el **Phone Number ID** y el **access token temporal**. Obtener el **App Secret** desde la configuración de la app, no desde el chat. El token temporal caduca: prepararlo cerca del ensayo.
3. Elegir un `META_VERIFY_TOKEN` aleatorio y guardar el mismo valor para la futura configuración de **Webhooks** en Meta. No reemplazar el App Secret con este token: cumplen funciones distintas.
4. En el worktree `houndfe-chatbot-human-decisions`, crear **a mano** el archivo `.env.local` (ya ignorado por Git), con permisos de solo propietario (`chmod 600 .env.local`). No pegar ningún valor en el chat, capturas, commits ni logs. Usar los nombres exactos:

   ```text
   META_VERIFY_TOKEN
   META_APP_SECRET
   META_ACCESS_TOKEN
   META_PHONE_NUMBER_ID
   META_SANDBOX_RECIPIENT
   META_GRAPH_API_VERSION
   ```

   `META_SANDBOX_RECIPIENT` es el WhatsApp ID **solo dígitos, sin `+`**, del teléfono de prueba ya verificado; no es el Phone Number ID del número emisor. `META_GRAPH_API_VERSION` es opcional (valor por defecto `v23.0`); si Meta pide otra versión, usar el formato `vN.N`. No crear `OPS_CHANNEL_PHONE` para esta demo.

5. Si se aprueba después el ensayo de IA real, añadir `OPENAI_API_KEY` y `OPENAI_SANDBOX_MODEL` al mismo archivo. Los únicos modelos admitidos son `gpt-4.1-mini`, `gpt-4.1-nano` y `gpt-4o-mini`; **no elegir uno sin acuerdo**. Límites opcionales: `OPENAI_SANDBOX_MAX_CALLS` (máximo 5 por proceso), `OPENAI_SANDBOX_MAX_OUTPUT_TOKENS` (máximo 256 por llamada), `OPENAI_SANDBOX_MAX_INPUT_CHARS` (máximo 500) y `OPENAI_SANDBOX_TIMEOUT_MS` (máximo 20000). Se validan antes de abrir la app; las llamadas no tienen reintentos automáticos. Estos techos **no garantizan un límite en dólares**. La presencia de la clave **no** autoriza llamadas al proveedor.

## Límites antes de encender nada

- El perfil de prueba solo debe exponer `GET/POST /webhook`, escuchar en `127.0.0.1` y permanecer en **modo local** con emisor falso hasta las verificaciones independientes.
- `--outbound` habilitaría el emisor Meta detrás de una barrera de destinatario; `--llm` activaría un máximo de cinco intentos OpenAI por proceso, limitado a **cuatro entradas inocuas canónicas y tres respuestas fijas seguras**. Son opciones separadas y apagadas por defecto. **No ejecutar ninguna** antes de confirmar emisor/destinatario exactos, modelo/límites numéricos, y obtener autorización nueva para el primer envío y la primera llamada al LLM.
- No iniciar ngrok ni cambiar el callback del panel Meta todavía. Antes de hacerlo, registrar el callback anterior para poder restaurarlo; un túnel efímero puede caducar.
- El filtro entrante admite **solo texto simple** del destinatario aprobado. Un lote firmado anómalo/mixto o un mensaje con adjunto se detiene sin enviar (puede provocar reintentos Meta); esta demo **no** recibe comprobantes. Nada de ventas, catálogo de producción, Skydropx, base de datos persistente ni promesas de entrega al dispositivo. La bandeja POS de la junta es una **simulación offline sin HTTP** y no está conectada al canal.

## Comprobación segura

Tras crear el archivo, basta con confirmar **«archivo preparado»**. El asistente comprobará únicamente existencia/permisos y presencia de nombres requeridos, **sin imprimir valores**. No ejecutaremos el primer mensaje sin una confirmación explícita posterior del destinatario de prueba.
