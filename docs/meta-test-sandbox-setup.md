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

5. Si se aprueba después el ensayo de IA real, añadir `OPENAI_API_KEY` y el modelo/los límites que se acuerden. La sola presencia de la clave **no** autoriza llamadas al proveedor.

## Límites antes de encender nada

- El perfil de prueba solo debe exponer `GET/POST /webhook`, escuchar en `127.0.0.1` y permanecer en **modo local** con emisor falso hasta las verificaciones independientes.
- `--outbound` habilitaría el emisor Meta detrás de una barrera de destinatario: **no ejecutarlo** antes de confirmar conmigo el ID emisor y destinatario exactos, el gasto del LLM y obtener autorización nueva para el primer envío.
- No iniciar ngrok ni cambiar el callback del panel Meta todavía. Antes de hacerlo, registrar el callback anterior para poder restaurarlo; un túnel efímero puede caducar.
- Nada de ventas, catálogo de producción, Skydropx, base de datos persistente ni promesas de entrega al dispositivo. La bandeja POS de la junta es una **simulación offline sin HTTP** y no está conectada al canal.

## Comprobación segura

Tras crear el archivo, basta con confirmar **«archivo preparado»**. El asistente comprobará únicamente existencia/permisos y presencia de nombres requeridos, **sin imprimir valores**. No ejecutaremos el primer mensaje sin una confirmación explícita posterior del destinatario de prueba.
