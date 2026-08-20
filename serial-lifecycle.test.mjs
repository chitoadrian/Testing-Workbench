import assert from 'node:assert/strict';
import fs from 'node:fs';

const elements = new Map();
function element(id) {
  if (!elements.has(id)) elements.set(id, {
    id, disabled: false, hidden: false, value: id === 'baudRate' ? '115200' : '', textContent: '',
    className: '', dataset: {}, style: { setProperty() {} }, classList: { add() {}, remove() {}, toggle() {} },
    addEventListener(type,handler) { this.listeners??={};this.listeners[type]=handler; }, setAttribute() {},
    querySelector() { return element(`${id}-child`); }, append() {}, replaceChildren(){this.replaced=true;}
  });
  return elements.get(id);
}

globalThis.document = {
  readyState: 'loading', hidden: false,
  getElementById: element, addEventListener() {},
  querySelectorAll() { return []; }, createElement: element
};
globalThis.window = {
  isSecureContext: true, self: {}, top: {}, addEventListener() {}
};
window.top = window.self;
globalThis.location = { protocol: 'http:' };
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userAgent: 'Chrome/140', serial: { addEventListener() {}, getPorts: async () => [] } } });
globalThis.localStorage = { getItem() { return null; }, setItem() {} };

const { SerialWorkbench, withTimeout } = await import('./app.js');

// Una operación lenta siempre termina y no deja un diagnóstico esperando para siempre.
await assert.rejects(withTimeout(new Promise(() => {}), 10), error => error.name === 'TimeoutError');

// La limpieza libera cada recurso aunque una etapa individual falle.
const app = new SerialWorkbench();
const calls = [];
app.reader = { async cancel() { calls.push('reader.cancel'); throw new Error('cancel failure'); }, releaseLock() { calls.push('reader.release'); } };
app.writer = { async close() { calls.push('writer.close'); }, releaseLock() { calls.push('writer.release'); } };
app.port = { async close() { calls.push('port.close'); } };
app.portIsOpen = true;
app.pendingPings.add({ finish(value) { calls.push(`ping:${value}`); } });
await app.cleanupSerialConnection('test');
assert.deepEqual(calls, ['ping:null','reader.cancel','reader.release','writer.close','writer.release','port.close']);
assert.equal(app.port, null);
assert.equal(app.reader, null);
assert.equal(app.writer, null);
assert.equal(app.portIsOpen, false);
assert.equal(app.hardwareReady, false);

// Dos intentos simultáneos no pueden abrir el puerto dos veces.
const locked = new SerialWorkbench();
let opens = 0;
locked.cleanupSerialConnection = async () => {};
locked.openPort = async () => { opens += 1; await new Promise(resolve => setTimeout(resolve, 15)); };
const candidate = {};
await Promise.all([locked.connectPort(candidate), locked.connectPort(candidate)]);
assert.equal(opens, 1);

// sendRaw transmite bytes PING + LF real, nunca una secuencia "\\n" literal.
const raw = new SerialWorkbench();
let written;
raw.port = {};
raw.portIsOpen = true;
raw.writer = { async write(bytes) { written = bytes; } };
assert.equal(await raw.sendRaw('PING'), true);
assert.equal(new TextDecoder().decode(written), 'PING\n');

// Un PONG real recibido resuelve la solicitud pendiente.
const pong = raw.waitForPong(100);
raw.handleMessage('{"ok":true,"command":"PING","event":"pong"}');
assert.equal(typeof await pong, 'number');

// El buffer conserva fragmentos hasta recibir LF y tolera CRLF.
const fragmented = new SerialWorkbench();
const received = [];
fragmented.handleMessage = line => received.push(line);
fragmented.processReceivedChunk('{"event":"po');
assert.deepEqual(received, []);
fragmented.processReceivedChunk('ng"}\r\nTEXTO\nparcial');
assert.deepEqual(received, ['{"event":"pong"}','TEXTO']);
assert.equal(fragmented.buffer, 'parcial');

// Los controles físicos permanecen bloqueados hasta un PONG validado.
const hardwareControl = { disabled: false, title: '', setAttribute() {} };
document.querySelectorAll = selector => selector === '[data-hardware-control]' ? [hardwareControl] : [];
fragmented.setHardwareReady(false);
assert.equal(hardwareControl.disabled, true);
fragmented.setHardwareReady(true);
assert.equal(hardwareControl.disabled, false);

// Matriz estática UI → listener → comando → firmware.
const html = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const firmware = fs.readFileSync(new URL('./firmware.ino', import.meta.url), 'utf8');
const appSource = fs.readFileSync(new URL('./app.js', import.meta.url), 'utf8');
for (const command of ['SET:LED:1','SET:LED:0','BLINK:LED:10','BUZZER:STOP','SET:RELAY:1','SET:RELAY:0','PULSE:RELAY:500','GET:TEMP','GET:DISTANCE','GET:LDR','MOTOR:STOP']) {
  assert.ok(html.includes(`data-command="${command}"`), `Falta botón ${command}`);
  assert.ok(firmware.includes(command.replace(/:\d+$/, '')) || firmware.includes(command), `Firmware no reconoce ${command}`);
}
for (const id of ['pwmSend','toneSend','servoSend','motorForward','motorReverse']) assert.ok(appSource.includes(`'${id}'`), `Falta listener ${id}`);

// Pausa y limpieza de consola funcionan sin Arduino.
const monitor = new SerialWorkbench();
monitor.initMonitor();
element('pauseBtn').listeners.click();
assert.equal(monitor.paused,true);
element('clearBtn').listeners.click();
assert.equal(element('terminal').replaced,true);

console.log('serial-lifecycle: 9 grupos de pruebas superados');
