# Sistema de registro automático de gastos
### Bancolombia → Google Sheets → Telegram

Google Apps Script que captura transacciones bancarias por SMS y correo, las guarda en una hoja de cálculo y permite categorizarlas desde un bot de Telegram con botones.

**Stack:** Google Apps Script · Google Sheets · Gmail API · Telegram Bot API · App externa de reenvío de SMS

---

## Contenido

1. [Resumen del sistema](#1-resumen-del-sistema)
2. [Arquitectura y flujo de datos](#2-arquitectura-y-flujo-de-datos)
3. [Requisitos previos](#3-requisitos-previos)
4. [Estructura de la hoja de cálculo](#4-estructura-de-la-hoja-de-cálculo-bd_transacciones)
5. [Categorías de gasto](#5-categorías-de-gasto)
6. [Referencia de funciones](#6-referencia-de-funciones)
7. [Triggers (automatizaciones programadas)](#7-triggers-automatizaciones-programadas)
8. [Limitaciones y problemas conocidos](#8-limitaciones-y-problemas-conocidos)
9. [Cómo extender el sistema](#9-cómo-extender-el-sistema)

---

## 1. Resumen del sistema

Este script automatiza el registro de los gastos e ingresos de una cuenta Bancolombia. Cuando ocurre una transacción, el banco envía un SMS y/o un correo de notificación. El sistema:

1. Recibe esa notificación (por SMS reenviado desde el celular, o leyendo el correo de Bancolombia).
2. Extrae automáticamente el monto, la fecha, la hora, el comercio/contacto y el tipo de movimiento (ingreso o gasto).
3. Guarda el registro en una hoja de Google Sheets.
4. Envía un mensaje a Telegram con botones para que la persona elija a qué categoría pertenece ese gasto (de 19 categorías predefinidas).
5. Al presionar un botón, la categoría queda escrita en la misma fila de la hoja.

Adicionalmente, el sistema puede revisar periódicamente la bandeja de Gmail para capturar transacciones que no llegaron por SMS (por ejemplo, si el celular estaba apagado), evitando duplicados.

---

## 2. Arquitectura y flujo de datos

### Ruta 1 — Notificación por SMS

```
📱 Bancolombia envía SMS
        │
        ▼
App "SMS Forwarder" en el celular
        │
        ▼
POST al Web App (doPost)
        │
        ▼
parseTransaction()
        │
        ▼
Fila nueva en Sheets
        │
        ▼
Mensaje con botones en Telegram
```

### Ruta 2 — Notificación por correo (respaldo)

```
✉️ Correo de Bancolombia en Gmail
        │
        ▼
Trigger de tiempo ejecuta escanearCorreosBancolombia()
        │
        ▼
parseTransaction()
        │
        ▼
¿Ya existe en Sheets? (esTransaccionDuplicada)
        │
        ▼
Si es nueva: fila en Sheets + Telegram
```

### Ruta 3 — Categorización manual

```
👤 Usuario presiona un botón en Telegram
        │
        ▼
Telegram envía callback al Web App (doPost)
        │
        ▼
manejarRespuestaTelegram()
        │
        ▼
Se busca la fila por su ID único (txId)
        │
        ▼
Se escribe la categoría en la columna E
```

> **Nota:** El punto de entrada único del sistema es la función `doPost(e)`. Todas las peticiones externas —tanto el SMS reenviado como los clics de Telegram— llegan a la misma URL del Web App y se distinguen según el contenido del cuerpo de la petición.

---

## 3. Requisitos previos

| Componente | Para qué sirve |
|---|---|
| Cuenta de Google | Aloja el proyecto de Apps Script, la hoja de Sheets y el Gmail que recibe las notificaciones del banco. |
| Hoja de Google Sheets | Base de datos del sistema. Su ID va en `SPREADSHEET_ID` y el nombre de la pestaña en `SHEET_NAME`. |
| Bot de Telegram | Creado con `@BotFather`. Su token se guarda en las Propiedades del Script como `TELEGRAM_TOKEN`. |
| Chat ID de Telegram | Identifica a quién se le envían las notificaciones. Se guarda como `TELEGRAM_CHAT_ID`. |
| App "SMS Forwarder" (Android) | App instalada en el celular que reenvía cada SMS entrante como una petición HTTP POST hacia la URL del Web App. |
| Web App publicada | El script debe implementarse (Deploy → Web App) con acceso "Cualquier usuario" para que el celular y Telegram puedan enviarle peticiones. |

### Propiedades del script

El token y el chat ID de Telegram no están escritos en el código; se leen desde `PropertiesService` por seguridad:

```javascript
TELEGRAM_TOKEN = PropertiesService.getScriptProperties().getProperty('TELEGRAM_TOKEN');
TELEGRAM_CHAT_ID = PropertiesService.getScriptProperties().getProperty('TELEGRAM_CHAT_ID');
```

Se configuran en el editor de Apps Script: **Configuración del proyecto → Propiedades del script**.

---

## 4. Estructura de la hoja de cálculo (`BD_Transacciones`)

| Columna | Índice | Contenido |
|---|---|---|
| A | 0 | Fecha (dd/MM/yyyy) |
| B | 1 | Hora (HH:mm:ss) |
| C | 2 | Comercio / contacto (recipient) |
| D | 3 | Detalle adicional (vacío por defecto) |
| E | 4 | Categoría (se llena al presionar un botón en Telegram) |
| F | 5 | Monto (numérico) |
| G | 6 | Tipo de movimiento ("Sale" = gasto, "Llega" = ingreso) |
| H | 7 | Origen del registro ("SMS Celular" o "Correo Gmail") |
| I | 8 | ID único de la transacción (txId), usado para ubicar la fila al categorizar |

---

## 5. Categorías de gasto

El bot ofrece 19 categorías fijas, definidas en el arreglo `CATEGORIAS`. La opción "❌ Error" permite descartar una fila mal capturada (se elimina automáticamente, ver sección de triggers).

`🏠 Arriendo + Serv` · `🛒 Mercado` · `📱 Plan Móvil` · `🚗 Transporte` · `🐾 Mascotas` · `🟢 Ingreso` · `🐷 Ahorro` · `📈 Inversión` · `🍲 Almuerzos por fuera` · `💳 Deudas` · `💊 Suplementos` · `🧠 Psicólogo` · `🏋️ Gimnasio` · `🎉 Salidas` · `🛍️ Compras` · `⚠️ Imprevistos` · `🛵 Domicilios` · `✈️ Viajes` · `📺 Subscripciones` · `❌ Error`

---

## 6. Referencia de funciones

### `doPost(e)` — Punto de entrada

Recibe todas las peticiones HTTP POST al Web App. Determina si la petición viene de:

- **Telegram** (un `callback_query`, generado al presionar un botón) → llama a `manejarRespuestaTelegram()`.
- **El celular** (un SMS reenviado) → extrae el texto del mensaje, llama a `parseTransaction()`, guarda la fila y notifica por Telegram.

Incluye manejo de errores (try/catch) para que una petición mal formada no rompa el flujo.

### `parseTransaction(body, backupTime)` — Extracción de datos

El motor central del sistema. Recibe el texto crudo del SMS o correo y, usando expresiones regulares, identifica:

- Monto (soporta formatos de Bancolombia y de Wompi).
- Fecha y hora (o usa la fecha/hora actual si no las encuentra).
- Tipo de movimiento: compra/pago, retiro, transferencia enviada, transferencia recibida.
- Comercio o contacto, limpiando frases sobrantes del texto del banco (por ejemplo "desde tu cuenta...").

Devuelve `null` si el texto no coincide con ningún patrón conocido (para no registrar mensajes irrelevantes).

### `parseAmount(amountStr)` — Formato numérico

Convierte el monto extraído (texto, con puntos o comas como separadores) a un número usable en la hoja, detectando si el separador decimal es coma o punto.

### `enviarNotificacionTelegram(tx, monto, txId)` — Notificación

Construye y envía el mensaje de Telegram con el detalle de la transacción y un teclado en línea (`inline_keyboard`) de 3 botones por fila, uno por cada categoría. Cada botón lleva codificado `txId|índiceDeCategoría` en su `callback_data`, que es lo que permite luego identificar qué fila y qué categoría corresponde.

### `manejarRespuestaTelegram(callbackQuery)` — Categorización

Se ejecuta cuando el usuario presiona un botón. Decodifica el `callback_data`, busca en la columna I (`txId`) la fila correspondiente, escribe la categoría en la columna E y edita el mensaje original en Telegram para quitar los botones y mostrar la categoría elegida.

### `actualizarMensajeTelegram(messageId, textoOriginal, categoria)` — UI de Telegram

Edita el mensaje ya enviado en Telegram (vía `editMessageText`) para reemplazar la pregunta "¿A qué categoría corresponde?" por la confirmación de la categoría elegida, y elimina los botones.

### `escanearCorreosBancolombia()` — Respaldo por correo

Pensada para ejecutarse periódicamente mediante un trigger de tiempo. Busca en Gmail los correos no leídos de Bancolombia de las últimas 2 horas, extrae la transacción con `parseTransaction()`, revisa si ya fue registrada por SMS (`esTransaccionDuplicada()`) y, si no, la agrega a la hoja y notifica por Telegram. Al final marca los correos como leídos.

### `esTransaccionDuplicada(parsedData, cleanAmount, registros)` — Control de duplicados

Compara la transacción encontrada en el correo contra las últimas 100 filas de la hoja, verificando coincidencia de monto, fecha y una diferencia de hora menor o igual a 30 minutos. Evita registrar dos veces la misma transacción cuando llega tanto por SMS como por correo.

### `obtenerMinutosDelDia(horaStr)` — Utilidad

Convierte una hora en formato "HH:mm" a minutos totales del día, para poder comparar horas fácilmente en `esTransaccionDuplicada()`.

### `limpiarTransaccionesConError()` — Mantenimiento

Pensada para ejecutarse periódicamente mediante un trigger de tiempo. Recorre la columna de categorías y elimina físicamente cualquier fila marcada como "Error" (categoría elegida cuando una transacción se capturó mal).

---

## 7. Triggers (automatizaciones programadas)

Dos funciones del script no se llaman desde `doPost`, sino que deben programarse manualmente en el editor de Apps Script (ícono de reloj → Triggers):

| Función | Frecuencia sugerida | Propósito |
|---|---|---|
| `escanearCorreosBancolombia` | Cada 1–2 horas | Capturar transacciones que no llegaron por SMS. |
| `limpiarTransaccionesConError` | Diaria o semanal | Eliminar filas descartadas manualmente. |

> También hay que configurar el **webhook de Telegram** (una sola vez) para que apunte a la URL del Web App publicado, de forma que los clics en los botones lleguen a `doPost`.

---

## 8. Limitaciones y problemas conocidos

- El reconocimiento de patrones (montos, comercios, tipos de movimiento) depende del formato exacto de los mensajes de Bancolombia y Wompi; un cambio en la redacción de esos mensajes puede requerir ajustar las expresiones regulares en `parseTransaction()`.
- La app externa de reenvío de SMS es un punto de fallo: si pierde permisos o conexión, esas transacciones solo se recuperarán vía el escaneo de correo (con un retraso de hasta el intervalo del trigger).
- La detección de duplicados usa una ventana de 30 minutos; transacciones del mismo monto realizadas dentro de ese margen podrían marcarse incorrectamente como duplicadas.
- El Web App debe permanecer publicado con los permisos correctos; si se vuelve a implementar (nuevo deployment) sin actualizar la URL en la app de SMS y en el webhook de Telegram, el sistema deja de recibir datos.

---

## 9. Cómo extender el sistema

- **Nuevas categorías:** agregar el emoji + nombre al arreglo `CATEGORIAS`; el teclado de Telegram se genera automáticamente a partir de esa lista.
- **Nuevos formatos de mensaje:** añadir un nuevo patrón (regex) dentro de `parseTransaction()`, siguiendo la misma estructura de los existentes (monto, fecha, hora, tipo, destinatario).
- **Detalle adicional (columna D):** puede aprovecharse el flujo de `doPost` para detectar respuestas ("reply") a un mensaje de Telegram y escribir ese texto en la columna D de la fila correspondiente al `txId`.

---

*Documentación generada a partir del código fuente del proyecto de Google Apps Script.*
