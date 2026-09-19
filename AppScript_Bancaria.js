// ==========================================
// CONFIGURACIÓN GLOBAL
// ==========================================
const SPREADSHEET_ID = '1q2kifenIlSLU-ptg_nAcoGPG28Hr5aa3DqnSEGBSnyU';
const SHEET_NAME = 'BD_Transacciones';

// CONFIGURACIÓN TELEGRAM
const TELEGRAM_TOKEN = PropertiesService.getScriptProperties().getProperty('TELEGRAM_TOKEN');
const TELEGRAM_CHAT_ID = PropertiesService.getScriptProperties().getProperty('TELEGRAM_CHAT_ID');

// 19 categorías personalizadas
const CATEGORIAS = [
  '🏠 Arriendo + Serv', '🛒 Mercado', '📱 Plan Movil',
  '🚗 Transporte', '🐾 Mascotas', '🟢 Ingreso',
  '🐷 Ahorro', '📈 Inversión', '🍲 Almuerzos por fuera',
  '💳 Deudas', '💊 Suplementos', '🧠 Psicologo',
  '🏋️ Gimnasio', '🎉 Salidas', '🛍️ Compras',
  '⚠️ Imprevistos', '🛵 Domicilios', '✈️ Viajes',
  '📺 Subcripciones', '❌ Error'
];

/**
 * RECEPTOR WEBHOOK CENTRALIZADO (BLINDADO)
 * Atiende las entradas automáticas de SMS y clics de botones en Telegram.
 */
function doPost(e) {
  try {
    if (!e) {
      return ContentService.createTextOutput(JSON.stringify({"status": "no data"})).setMimeType(ContentService.MimeType.JSON);
    }

    let dataObj = {};
   
    // BLINDAJE DE ENTRADA: Detectar si el celular envía JSON o formulario clásico
    if (e.postData && e.postData.contents) {
      try {
        dataObj = JSON.parse(e.postData.contents);
      } catch(rawError) {
        dataObj = e.parameter;
      }
    } else if (e.parameter) {
      dataObj = e.parameter;
    }

    // CASO A: Viene de Telegram (El usuario presionó un botón de categoría)
    if (dataObj.callback_query || (dataObj.contents && JSON.parse(dataObj.contents).callback_query)) {
      const cb = dataObj.callback_query ? dataObj.callback_query : JSON.parse(dataObj.contents).callback_query;
      return manejarRespuestaTelegram(cb);
    }
   
    // CASO B: Viene del Celular (SMS real interceptado)
    const smsBody = dataObj.message || dataObj.Message || dataObj.text || dataObj.sms_body;
    const smsTime = dataObj.time || dataObj.Time || dataObj.sms_time;
   
    if (!smsBody) {
      console.warn("Se recibió una petición pero no contenía ningún cuerpo de mensaje.");
      return ContentService.createTextOutput(JSON.stringify({"status": "no message found"})).setMimeType(ContentService.MimeType.JSON);
    }
   
    let parsedData = parseTransaction(smsBody, smsTime);
   
    if (parsedData) {
      const sheet = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(SHEET_NAME);
      const cleanAmount = parseAmount(parsedData.amountStr);
     
      const txId = 'tx_' + new Date().getTime() + Math.floor(Math.random() * 10);
     
      sheet.appendRow([
        parsedData.date,
        parsedData.time,
        parsedData.recipient,
        '',
        '', // Columna E: Categoría (Vacío inicialmente)
        cleanAmount,
        parsedData.type,
        'SMS Celular',
        txId
      ]);
     
      enviarNotificacionTelegram(parsedData, cleanAmount, txId);
    } else {
      console.warn("El SMS recibido no coincidió con ninguna regla de Bancolombia/Wompi: " + smsBody);
    }
   
    return ContentService.createTextOutput(JSON.stringify({"status": "success"})).setMimeType(ContentService.MimeType.JSON);

  } catch (error) {
    console.error("Error crítico en doPost: " + error.message);
    return ContentService.createTextOutput(JSON.stringify({"status": "error", "message": error.message})).setMimeType(ContentService.MimeType.JSON);
  }
}

/**
 * ENVÍA EL MENSAJE CON BOTONES A TELEGRAM
 */
function enviarNotificacionTelegram(tx, monto, txId) {
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
 
  let stringMonto = monto.toString();
  if (typeof monto === 'number') {
    stringMonto = monto.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  }
 
  const tipoTx = (tx.type || 'Sale').toLowerCase();
  const montoFormateado = tipoTx === 'sale' ? `🔴 -$${stringMonto}` : `🟢 +$${stringMonto}`;
 
  const comercioLimpio = (tx.recipient || "Comercio")
    .replace(/[*_`\[\]()]/g, '')
    .trim();

  const textoMensaje = `💰 *Nueva Transacción Detectada*\n` +
                       `----------------------------------\n` +
                       `• *Comercio:* ${comercioLimpio}\n` +
                       `• *Monto:* ${montoFormateado}\n` +
                       `• *Tipo:* ${tx.type || 'Sale'}\n` +
                       `• *Fecha/Hora:* ${tx.date} - ${tx.time}\n\n` +
                       `¿A qué categoría corresponde? 👇`;

  let keyboard = [];
  let fila = [];
 
  for (let i = 0; i < CATEGORIAS.length; i++) {
    fila.push({
      text: CATEGORIAS[i],
      callback_data: `${txId}|${i}`
    });
    if (fila.length === 3 || i === CATEGORIAS.length - 1) {
      keyboard.push(fila);
      fila = [];
    }
  }

  const payload = {
    chat_id: TELEGRAM_CHAT_ID,
    text: textoMensaje,
    parse_mode: 'Markdown',
    reply_markup: JSON.stringify({ inline_keyboard: keyboard })
  };

  const respuesta = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
 
  console.log("Respuesta envío Telegram: " + respuesta.getContentText());
}

/**
 * PROCESA EL CLIC EN EL BOTÓN DE TELEGRAM
 */
function manejarRespuestaTelegram(callbackQuery) {
  const data = callbackQuery.data;
  const parts = data.split('|');
  const txId = parts[0];
  const indiceCategoria = parseInt(parts[1], 10);
  const categoriaConEmoji = CATEGORIAS[indiceCategoria];
 
  let categoriaSeleccionada = "";
  if (categoriaConEmoji.includes("Error")) {
    categoriaSeleccionada = "Error";
  } else {
    categoriaSeleccionada = categoriaConEmoji.substring(3).trim();
  }

  const messageId = callbackQuery.message.message_id;
  const textoOriginal = callbackQuery.message.text;
 
  let exitoSheets = false;

  try {
    const sheet = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(SHEET_NAME);
    const columnaI = sheet.getRange("I:I").getValues();
    let filaEncontrada = -1;
   
    for (let i = 0; i < columnaI.length; i++) {
      if (columnaI[i][0] === txId) {
        filaEncontrada = i + 1;
        break;
      }
    }

    if (filaEncontrada !== -1) {
      sheet.getRange(filaEncontrada, 5).setValue(categoriaSeleccionada);
      exitoSheets = true;
      actualizarMensajeTelegram(messageId, textoOriginal, categoriaConEmoji);
    } else {
      actualizarMensajeTelegram(messageId, textoOriginal, "⚠️ Error: ID no encontrado.");
    }
  } catch (err) {
    console.error("Error al escribir en Sheets: " + err.message);
    actualizarMensajeTelegram(messageId, textoOriginal, "⚠️ Error interno de Sheets.");
  }

  const urlRespuesta = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/answerCallbackQuery`;
  UrlFetchApp.fetch(urlRespuesta, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({
      callback_query_id: callbackQuery.id,
      text: exitoSheets ? `✅ Marcado: ${categoriaSeleccionada}` : "❌ Error al guardar"
    }),
    muteHttpExceptions: true
  });

  return ContentService.createTextOutput(JSON.stringify({"status": "success"})).setMimeType(ContentService.MimeType.JSON);
}

/**
 * EDITA EL MENSAJE EN TELEGRAM PARA REMOVER LOS BOTONES
 */
function actualizarMensajeTelegram(messageId, textoOriginal, categoria) {
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/editMessageText`;
 
  const textoLimpio = textoOriginal.split('¿A qué categoría')[0];
  const nuevoTexto = `${textoLimpio}✅ *Categoría:* ${categoria}`;

  const payload = {
    chat_id: TELEGRAM_CHAT_ID,
    message_id: messageId,
    text: nuevoTexto,
    parse_mode: 'Markdown',
    reply_markup: JSON.stringify({ inline_keyboard: [] })
  };

  UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
}

/**
 * MOTOR DE EXTRACCIÓN
 */
function parseTransaction(body, backupTime) {
  if (!body || body.trim().length < 5) return null;
  const text = body.replace(/[\s\n\r]+/g, ' ').trim();

  let amountStr = "";
  const wompiAmountMatch = text.match(/Monto:\s*COP\s*\$\s*([0-9.,]+)/i) || text.match(/COP\s*\$\s*([0-9.,]+)/i);
  const regularAmountMatch = text.match(/\$\s*([0-9.,]+)/);
 
  if (wompiAmountMatch) { amountStr = wompiAmountMatch[1]; }
  else if (regularAmountMatch) { amountStr = regularAmountMatch[1]; }
  else { return null; }

  let rawDate = ""; let time = "";
  const dateMatch = text.match(/(\d{2}\/\d{2}\/\d{2,4})/);
  const timeMatch = text.match(/(\d{2}:\d{2}(?::\d{2})?)/);
 
  if (dateMatch) {
    rawDate = dateMatch[1];
    const dateParts = rawDate.split('/');
    if (dateParts[2] && dateParts[2].length === 2) { rawDate = `${dateParts[0]}/${dateParts[1]}/20${dateParts[2]}`; }
  } else {
    rawDate = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "dd/MM/yyyy");
  }
 
  if (timeMatch) { time = timeMatch[1]; }
  else { time = backupTime ? backupTime : Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "HH:mm:ss"); }

  let recipient = ""; let type = "Sale";

  if (/\bwompi\b/i.test(text) || /Tu transacción fue APROBADA/i.test(text)) {
    type = "Sale";
    const wompiMatch = text.match(/pago realizado a\s+(.*?)\s+y el dinero/i) || text.match(/Boton Bancolombia a\s+(.*?)\s+desde/i);
    recipient = wompiMatch ? wompiMatch[1].trim() : "Wompi SAS";
  } else if (/\b(retiraste|retiro)\b/i.test(text)) {
    type = "Sale"; recipient = "RETIRO CAJERO";
  } else if (/\b(recibiste|ingreso)\b/i.test(text)) {
    type = "Llega";
    const recMatch = text.match(/transferencia de\s+(.*?)\s+por\s*\$/i) || text.match(/pago de\s+(.*?)\s+(?:el|\$)/i);
    recipient = recMatch ? recMatch[1].trim() : "Transferencia Recibida";
  } else if (/\b(transferiste)\b/i.test(text)) {
    type = "Sale";
    const keyTransferMatch = text.match(/desde tu cuenta\s+.*?\s+a\s+(.*?)\s+el/i);
    const regularTransferMatch = text.match(/transferiste\s+\$[0-9.,]+\s+.*?a\s+(.*?)\s+(?:el|desde)/i);
    if (keyTransferMatch) { recipient = keyTransferMatch[1].trim(); }
    else if (regularTransferMatch) { recipient = regularTransferMatch[1].trim(); }
    else { recipient = "Transferencia Enviada"; }
  } else if (/\b(pagaste|compraste|compra)\b/i.test(text)) {
    type = "Sale";
    if (/\bQR\b/i.test(text)) { recipient = "Pago QR"; }
    else {
      const payMatch = text.match(/(?:pagaste|compraste)\s+\$[0-9.,]+\s+(?:a|en)\s+(.*?)\s+(?:desde|con|el)/i);
      recipient = payMatch ? payMatch[1].trim() : "Compra/Pago";
    }
  } else { recipient = "Transacción Bancolombia"; }

  if (recipient !== "RETIRO CAJERO" && recipient !== "Pago QR") {
    recipient = recipient.replace(/(desde tu producto|en tu cuenta|desde tu cuenta|por \$|con tu T\.Deb).*$/i, '').trim();
    recipient = recipient.replace(/[.,\s\-\(\)]+$/, '').trim();
  }
  if (!recipient || recipient.length < 2) { recipient = (type === "Llega") ? "Transferencia Recibida" : "Pago Bancolombia"; }

  return { amountStr, date: rawDate, time, recipient, type };
}

/**
 * FORMATEADOR DE DINERO
 */
function parseAmount(amountStr) {
  if (!amountStr) return 0;
  let cleanStr = amountStr.replace(/[^0-9.,]/g, '');
  if (cleanStr.includes(',') && cleanStr.includes('.')) {
    if (cleanStr.indexOf('.') < cleanStr.indexOf(',')) { cleanStr = cleanStr.replace(/\./g, '').replace(',', '.'); }
    else { cleanStr = cleanStr.replace(/,/g, ''); }
  } else if (cleanStr.includes(',')) {
    const parts = cleanStr.split(',');
    if (parts[parts.length - 1].length === 2) { cleanStr = cleanStr.replace(/,/g, '.'); }
    else { cleanStr = cleanStr.replace(/,/g, ''); }
  }
  return parseFloat(cleanStr) || 0;
}

/**
 * ESCANEA LOS CORREOS DE BANCOLOMBIA PARA BUSCAR TRANSACCIONES HUÉRFANAS
 * Programado para correr periódicamente con Trigger (Reloj).
 */
function escanearCorreosBancolombia() {
  const query = 'from:alertasynotificaciones@an.notificacionesbancolombia.com is:unread newer_than:2h';
  const threads = GmailApp.search(query);
 
  if (threads.length === 0) return;
 
  const sheet = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(SHEET_NAME);
 
  const numFilas = sheet.getLastRow();
  let ultimosRegistros = [];
  if (numFilas >= 2) {
    const filaInicio = Math.max(2, numFilas - 99);
    const cantidadFilas = numFilas - filaInicio + 1;
    ultimosRegistros = sheet.getRange(filaInicio, 1, cantidadFilas, 9).getValues();
  }

  for (let i = 0; i < threads.length; i++) {
    const messages = threads[i].getMessages();
   
    for (let j = 0; j < messages.length; j++) {
      const msg = messages[j];
      if (!msg.isUnread()) continue;
     
      const cuerpoCorreo = msg.getPlainBody();
      const fechaRecibido = msg.getDate();
      const backupTime = Utilities.formatDate(fechaRecibido, Session.getScriptTimeZone(), "HH:mm:ss");
     
      let parsedData = parseTransaction(cuerpoCorreo, backupTime);
     
      if (parsedData) {
        const cleanAmount = parseAmount(parsedData.amountStr);
       
        if (esTransaccionDuplicada(parsedData, cleanAmount, ultimosRegistros)) {
          console.log(`Duplicado detectado por correo: ${parsedData.recipient} por $${cleanAmount}. Ignorando.`);
          msg.markRead();
          continue;
        }
       
        const txId = 'tx_mail_' + new Date().getTime() + Math.floor(Math.random() * 10);
       
        sheet.appendRow([
          parsedData.date,
          parsedData.time,
          parsedData.recipient,
          '',
          '',
          cleanAmount,
          parsedData.type,
          'Correo Gmail',
          txId
        ]);
       
        enviarNotificacionTelegram(parsedData, cleanAmount, txId);
      }
     
      msg.markRead();
    }
  }
}

/**
 * COMPARA LA TRANSACCIÓN DEL CORREO CONTRA LOS REGISTROS DEL SHEETS
 */
function esTransaccionDuplicada(parsedData, cleanAmount, registros) {
  if (!registros || registros.length === 0) return false;
 
  const montoCorreo = Math.round(parseFloat(cleanAmount));
  const partesFecha = parsedData.date.split('/');
  const fechaCorreoNorm = `${partesFecha[0].padStart(2, '0')}/${partesFecha[1].padStart(2, '0')}/${partesFecha[2]}`;
  const minutosCorreo = obtenerMinutosDelDia(parsedData.time);

  for (let i = 0; i < registros.length; i++) {
    const fila = registros[i];
    if (!fila || !fila[0]) continue;
   
    // 1. Extraer Monto (Columna F / Índice 5)
    let filaMonto = 0;
    const valMonto = fila[5];
   
    if (typeof valMonto === 'number') {
      filaMonto = Math.round(valMonto);
    } else if (valMonto) {
      filaMonto = Math.round(parseAmount(valMonto.toString()));
    }

    if (filaMonto !== montoCorreo) continue;

    // 2. Extraer Fecha (Columna A / Índice 0)
    let filaFechaNorm = "";
    if (fila[0] instanceof Date) {
      filaFechaNorm = Utilities.formatDate(fila[0], Session.getScriptTimeZone(), "dd/MM/yyyy");
    } else {
      const p = fila[0].toString().trim().split('/');
      if (p.length === 3) {
        filaFechaNorm = `${p[0].padStart(2, '0')}/${p[1].padStart(2, '0')}/${p[2]}`;
      }
    }

    if (filaFechaNorm !== fechaCorreoNorm) continue;

    // 3. Extraer Hora (Columna B / Índice 1)
    let minutosFila = -1;
    if (fila[1] instanceof Date) {
      const horaFormateada = Utilities.formatDate(fila[1], Session.getScriptTimeZone(), "HH:mm");
      minutosFila = obtenerMinutosDelDia(horaFormateada);
    } else if (fila[1]) {
      minutosFila = obtenerMinutosDelDia(fila[1].toString());
    }

    // 4. Evaluar duplicado
    if (minutosCorreo !== -1 && minutosFila !== -1) {
      const diff = Math.abs(minutosCorreo - minutosFila);
      if (diff <= 30) {
        console.log(`🎯 Duplicado encontrado: Monto ($${filaMonto}), Fecha (${filaFechaNorm}) y Hora diff: ${diff}m.`);
        return true;
      }
    } else {
      console.log(`🎯 Duplicado encontrado por Monto ($${filaMonto}) y Fecha (${filaFechaNorm}).`);
      return true;
    }
  }
 
  return false;
}

function obtenerMinutosDelDia(horaStr) {
  if (!horaStr) return -1;
  const partes = horaStr.toString().trim().split(':');
  if (partes.length >= 2) {
    const hh = parseInt(partes[0], 10);
    const mm = parseInt(partes[1], 10);
    if (!isNaN(hh) && !isNaN(mm)) {
      return hh * 60 + mm;
    }
  }
  return -1;
}

/**
 * BORRA FÍSICAMENTE LAS FILAS MARCADAS COMO "Error" EN SHEETS
 * Programado para correr periódicamente con Trigger (Reloj).
 */
function limpiarTransaccionesConError() {
  const sheet = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(SHEET_NAME);
  const lastRow = sheet.getLastRow();
 
  if (lastRow <= 1) return;

  const categorias = sheet.getRange(2, 5, lastRow - 1, 1).getValues();
  let filasBorradas = 0;

  for (let i = categorias.length - 1; i >= 0; i--) {
    const valorCategoria = categorias[i][0].toString().trim();
   
    if (valorCategoria.toLowerCase() === "error") {
      const filaABorrar = i + 2;
      sheet.deleteRow(filaABorrar);
      filasBorradas++;
    }
  }

  if (filasBorradas > 0) {
    console.log(`🧹 Limpieza completada: Se borraron ${filasBorradas} fila(s) con Error.`);
  }
}