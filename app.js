import {FirmwareManager} from './firmware-manager.js';

const TIMEOUT = 2500;
const RESET_DELAY = 1800;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function withTimeout(promise, ms = TIMEOUT, message = 'La operación excedió el tiempo de espera.') {
  let timer;
  const limit = new Promise((_, reject) => { timer = setTimeout(() => reject(new DOMException(message, 'TimeoutError')), ms); });
  return Promise.race([Promise.resolve(promise), limit]).finally(() => clearTimeout(timer));
}

class SerialWorkbench {
  constructor() {
    Object.assign(this, { port: null, reader: null, writer: null, readableClosed: null, writableClosed: null,
      keepReading: false, hardwareReady: false, paused: false, buffer: '', sessionStartedAt: Date.now(),
      operationStartedAt: null, authorizedPorts: [], sessionTimer: null, stressCancelled: false,
      connectionInProgress: false, portIsOpen: false, cleanupInProgress: null, connectionStateName: 'disconnected' });
    this.pendingPings = new Set();
    this.pendingFirmwareInfo = new Set();
    this.decoder = new TextDecoder();
    this.metrics = { cycles: 0, operationMs: 0, errors: 0 };
    this.e = this.cacheElements();
  }

  cacheElements() {
    const ids = ['baudRate','connectBtn','statusBadge','sessionTime','rxCount','txCount','latency','startupStatus',
      'diagnosticMessage','searchDeviceBtn','reconnectBtn','retryDiagnosticsBtn','checkInterface','checkJavaScript',
      'checkWebSerial','checkSecureContext','checkUsbDevice','checkAuthorized','checkPortOpen','checkFirmware','checkArduino',
      'testPingBtn','resetSerialBtn','forgetDeviceBtn','initErrorCard','initErrorModule','initErrorMessage','retryInitBtn',
      'commandForm','commandInput','clearBtn','pauseBtn','autoscroll','terminal','toast','resetMetrics','stressBtn',
      'cancelStressBtn','stressStatus','stressProgress','pwmSlider','pwmValue','toneSlider','toneValue','servoSlider',
      'servoValue','motorSlider','motorValue','pwmSend','toneSend','servoSend','motorForward','motorReverse','tempReading',
      'humidityReading','distanceReading','ldrReading','cycleCount','errorCount','operationTime','healthPercent','healthScore','healthState','hardwareHint'];
    return Object.fromEntries(ids.map(id => [id, document.getElementById(id)]));
  }

  async initialize() {
    this.startup('Inicializando interfaz...');
    const modules = [['Interfaz',()=>this.initUI()],['Conexión Serial',()=>this.initSerial()],['Firmware Manager',()=>this.initFirmwareManager()],['Diagnóstico',()=>this.initDiagnostics()],
      ['Galería',()=>this.initGallery()],['Monitor Serial',()=>this.initMonitor()],['Métricas',()=>this.initMetrics()],
      ['Health Check',()=>this.initHealth()],['Stress Test',()=>this.initStress()]];
    for (const [name, init] of modules) {
      try { await Promise.resolve(init()); }
      catch (error) { console.error(`[${name}]`, error); this.showInitError(name, error); }
    }
    this.startup('Interfaz lista');
    await this.runDiagnostics();
  }

  initUI() {
    this.require(['connectBtn','statusBadge','startupStatus','toast']);
    this.check('checkInterface', true, 'Interfaz'); this.check('checkJavaScript', true, 'JavaScript');
    this.setHardwareReady(false);
    this.e.connectBtn.addEventListener('click', () => this.portIsOpen ? this.disconnect() : this.connectSelectedOrPick());
    this.e.baudRate.addEventListener('change', () => { if(this.e.baudRate.value!=='115200')this.toast('El firmware actual utiliza 115200.'); });
    this.e.retryInitBtn?.addEventListener('click', () => { this.e.initErrorCard.hidden = true; void this.runDiagnostics(); });
  }
  initSerial() {
    if ('serial' in navigator) {
      navigator.serial.addEventListener('disconnect', event => {
        if (event.target === this.port) void this.unexpectedDisconnect();
        else void this.runDiagnostics();
      });
      navigator.serial.addEventListener('connect', () => {
        this.serialLog('Dispositivo Serial detectado');
        this.check('checkUsbDevice',true,'Dispositivo USB');
        this.message('Dispositivo Serial detectado. Pulse Buscar dispositivo o Reconectar.');
        void this.runDiagnostics({preserveMessage:true});
      });
    }
    window.addEventListener('pagehide', () => {
      this.keepReading=false; this.stressCancelled=true;
      try{void this.reader?.cancel();}catch{}
      try{this.reader?.releaseLock();}catch{}
      try{this.writer?.releaseLock();}catch{}
    });
  }
  initFirmwareManager(){this.firmwareManager=new FirmwareManager(this);this.firmwareManager.init();}
  initDiagnostics() {
    this.require(['searchDeviceBtn','reconnectBtn','testPingBtn','resetSerialBtn','forgetDeviceBtn','retryDiagnosticsBtn','diagnosticMessage']);
    this.e.searchDeviceBtn.addEventListener('click', () => this.connectWithPicker());
    this.e.reconnectBtn.addEventListener('click', () => this.reconnectAuthorized());
    this.e.testPingBtn.addEventListener('click', () => this.testPing());
    this.e.resetSerialBtn.addEventListener('click', () => this.resetSerialSession());
    this.e.forgetDeviceBtn.addEventListener('click', () => this.forgetOrChangeDevice());
    this.e.retryDiagnosticsBtn.addEventListener('click', () => this.runDiagnostics());
  }
  initGallery() {
    document.querySelectorAll('.tab').forEach(tab => tab.addEventListener('click', () => this.activateTab(tab)));
    document.querySelectorAll('[data-command]').forEach(button => {
      button.dataset.hardwareControl = '';
      button.addEventListener('click', () => this.send(button.dataset.command, button.dataset.component));
    });
    ['pwmSend','toneSend','servoSend','motorForward','motorReverse'].forEach(id => { this.e[id].dataset.hardwareControl = ''; });
    this.linkRange('pwmSlider','pwmValue',v=>v); this.linkRange('toneSlider','toneValue',v=>`${v} Hz`);
    this.linkRange('servoSlider','servoValue',v=>`${v}°`); this.linkRange('motorSlider','motorValue',v=>`${v}%`);
    this.on('pwmSend','click',()=>this.send(`SET:LED:PWM:${this.e.pwmSlider.value}`,'LED'));
    this.on('toneSend','click',()=>this.send(`BUZZER:${this.e.toneSlider.value}:500`,'BUZZER'));
    this.on('servoSend','click',()=>this.send(`SERVO:${this.e.servoSlider.value}`,'SERVO'));
    this.on('motorForward','click',()=>this.send(`MOTOR:FWD:${this.e.motorSlider.value}`,'MOTOR'));
    this.on('motorReverse','click',()=>this.send(`MOTOR:REV:${this.e.motorSlider.value}`,'MOTOR'));
    this.setHardwareReady(false);
  }
  initMonitor() {
    this.require(['commandForm','commandInput','clearBtn','pauseBtn','terminal']);
    this.e.commandForm.addEventListener('submit', event => { event.preventDefault(); const value=this.e.commandInput.value; this.e.commandInput.value=''; void this.send(value); });
    this.e.clearBtn.addEventListener('click', () => this.e.terminal.replaceChildren());
    this.e.pauseBtn.addEventListener('click', () => { this.paused=!this.paused; this.e.pauseBtn.textContent=this.paused?'Reanudar':'Pausar'; });
  }
  initMetrics() {
    this.metrics=this.loadMetrics(); this.renderMetrics();
    this.on('resetMetrics','click',()=>{ this.metrics={cycles:0,operationMs:0,errors:0}; this.saveMetrics(); this.renderMetrics(); });
  }
  initHealth() {
    this.startTimer();
    document.addEventListener('visibilitychange',()=>document.hidden?this.stopTimer():this.startTimer());
  }
  initStress() {
    this.on('stressBtn','click',()=>this.runStressTest());
    this.on('cancelStressBtn','click',()=>{this.stressCancelled=true;});
  }

  async runDiagnostics(options={}) {
    this.startup('Comprobando Web Serial...'); if(!options.preserveMessage)this.message('Comprobando navegador, contexto y puertos autorizados…');
    const file=location.protocol==='file:', secure=window.isSecureContext&&!file, serial='serial' in navigator, embedded=this.isEmbedded();
    this.check('checkWebSerial',serial,'Web Serial'); this.check('checkSecureContext',secure,'Contexto seguro');
    this.e.searchDeviceBtn.disabled=this.connectionInProgress||!serial||!secure||embedded; this.e.reconnectBtn.disabled=true;
    this.check('checkPortOpen',this.portIsOpen,'Puerto abierto');
    this.check('checkFirmware',this.hardwareReady,'Firmware responde');
    if (file) return this.diagnosticStop('No abra index.html directamente. Inicie el servidor local y utilice http://localhost:8080.');
    if (embedded) return this.diagnosticStop('La aplicación está ejecutándose en una vista previa integrada. Para utilizar Arduino por USB, ábrala directamente en Chrome o Edge.');
    if (!secure) return this.diagnosticStop('Web Serial requiere http://localhost:8080 o HTTPS.');
    if (!serial) {
      this.setStatus('error','Web Serial no disponible');
      return this.diagnosticStop(`Este navegador (${this.browser()}) no tiene Web Serial disponible. Utilice una versión actual de Chrome o Edge.`);
    }
    try {
      this.authorizedPorts=await withTimeout(navigator.serial.getPorts(),2200,'No se pudieron consultar puertos autorizados.');
      const authorized=this.authorizedPorts.length>0;
      this.check('checkAuthorized',authorized,'Puerto autorizado');
      this.check('checkUsbDevice',this.portIsOpen,'Dispositivo USB');
      this.e.reconnectBtn.disabled=this.connectionInProgress||!authorized||this.portIsOpen;
      if(!options.preserveMessage)this.message(authorized?`${this.authorizedPorts.length} dispositivo(s) autorizado(s). Puerto abierto: ${this.portIsOpen?'Sí':'No'}. Arduino responde: ${this.hardwareReady?'Sí':'No'}.`:'No hay dispositivos previamente autorizados. Pulse Buscar dispositivo.');
      this.startup('Web Serial disponible · Listo para conectar Arduino');
      this.firmwareManager?.refreshPort();
    } catch (error) {
      console.error('[Diagnóstico/getPorts]',error); this.authorizedPorts=[]; this.check('checkAuthorized',false,'Puerto autorizado');
      this.startup(error.name==='TimeoutError'?'No se pudo comprobar':'Interfaz lista');
      this.message('No se pudieron consultar puertos autorizados. Puede usar Buscar dispositivo.');
    }
  }
  diagnosticStop(text) { this.startup('No disponible'); this.message(text); }
  browser() { const ua=navigator.userAgent; return /Edg\//.test(ua)?'Microsoft Edge':/Chrome\//.test(ua)?'Google Chrome':/Chromium\/|OPR\//.test(ua)?'navegador Chromium':'navegador actual'; }
  isEmbedded() { try{return window.self!==window.top;}catch(error){console.warn('No se pudo comprobar el iframe.',error);return true;} }

  async connectSelectedOrPick() {
    if(this.connectionInProgress)return;
    const candidate=this.port||this.authorizedPorts[0];
    if(!candidate)return this.connectWithPicker();
    return this.connectPort(candidate,true);
  }
  async connectWithPicker() {
    if(this.connectionInProgress)return;
    if (!('serial' in navigator)) return this.diagnosticStop('Este navegador no tiene Web Serial disponible. Utilice una versión actual de Chrome o Edge.');
    if (!window.isSecureContext||location.protocol==='file:'||this.isEmbedded()) return this.runDiagnostics();
    this.connectionInProgress=true; this.setConnectionControlsBusy(true); this.connectionState('searching');
    this.serialLog('requestPort start');
    const cleanupPromise=this.cleanupSerialConnection('change-device',{keepUI:true});
    try {
      // Primer await del clic: siempre abre una selección real y conserva la activación del usuario.
      const newPort=await navigator.serial.requestPort();
      await cleanupPromise; this.port=newPort; this.serialLog('port selected');
      this.firmwareManager?.refreshPort();
      this.check('checkUsbDevice',true,'Dispositivo USB'); this.check('checkAuthorized',true,'Puerto autorizado');
      this.connectionState('selected'); await this.openPort();
    } catch(error) { await cleanupPromise; await this.connectionError(error); }
    finally { this.connectionInProgress=false; this.setConnectionControlsBusy(false); }
  }
  async reconnectAuthorized() {
    if(this.connectionInProgress)return;
    const candidate=this.authorizedPorts[0];
    if (!candidate) return this.toast('No hay un Arduino autorizado. Pulse Buscar dispositivo.');
    return this.connectPort(candidate,true);
  }
  async connectPort(candidate,isAuthorized=false) {
    if(this.connectionInProgress)return;
    this.connectionInProgress=true; this.setConnectionControlsBusy(true);
    try { await this.cleanupSerialConnection('before-connect',{keepUI:true}); this.port=candidate; this.connectionState('selected'); await this.openPort(); }
    catch(error) { await this.connectionError(error,{stale:isAuthorized}); }
    finally { this.connectionInProgress=false; this.setConnectionControlsBusy(false); }
  }
  async openPort() {
    if(!this.port)throw new DOMException('No existe un puerto seleccionado.','InvalidStateError');
    this.connectionState('opening'); this.serialLog(`opening ${this.e.baudRate.value}`);
    await withTimeout(this.port.open({baudRate:Number(this.e.baudRate.value),bufferSize:4096}),5000,'La apertura del puerto tardó demasiado.');
    this.portIsOpen=true; this.check('checkPortOpen',true,'Puerto abierto'); this.serialLog('port opened');
    this.reader=this.port.readable.getReader(); this.writer=this.port.writable.getWriter();
    this.keepReading=true; this.buffer=''; this.decoder=new TextDecoder(); this.operationStartedAt=Date.now(); this.serialLog('read loop started'); void this.readLoop();
    this.connectionState('initializing'); this.serialLog('waiting Arduino reset'); await delay(RESET_DELAY); this.buffer=''; this.connectionState('verifying');
    let latency=null;
    for(let attempt=1;attempt<=3&&latency==null;attempt++){
      const pong=this.waitForPong(1200); this.serialLog(`PING sent (intento ${attempt}/3)`);
      if(!await this.sendRaw('PING'))throw new DOMException('No se pudo enviar PING.','NetworkError');
      latency=await pong; if(latency==null&&attempt<3)await delay(250);
    }
    if (latency==null) { this.firmwareManager?.setFirmwareInfo(null);this.connectionState('firmware-timeout'); this.check('checkPortOpen',true,'Puerto abierto'); this.check('checkFirmware',false,'Firmware responde'); this.message('Puerto abierto, firmware sin respuesta. Puede usar Probar PING o instalar firmware.'); this.setConnectionControlsBusy(false); return; }
    this.serialLog('PONG received');
    const infoPromise=this.waitForFirmwareInfo(1600);await this.sendRaw('GET:INFO');const info=await infoPromise;
    this.firmwareManager?.setFirmwareInfo(info);
    if(info?.firmware!=='HW-WORKBENCH'){this.check('checkFirmware',false,'Firmware responde');this.connectionState('incompatible');this.message('Firmware no compatible o desactualizado. Puede instalar HW-WORKBENCH desde esta página.');this.setHardwareReady(false);return;}
    this.check('checkFirmware',true,'Firmware responde');this.e.latency.textContent=`${Math.round(latency)} ms`; this.connectionState('connected'); this.setHardwareReady(true);
    this.serialLog('connected'); this.log('system',`Arduino conectado a ${this.e.baudRate.value} baud.`);
  }
  async connectionError(error,options={}) {
    this.serialError(error);
    const map={NotFoundError:'Selección cancelada.',SecurityError:'El navegador o la política del equipo puede estar bloqueando el acceso a dispositivos Serial.',
      NetworkError:options.stale?'El puerto autorizado anteriormente ya no está disponible. Pulse Buscar dispositivo para seleccionarlo nuevamente.':'No se pudo abrir el puerto. Puede estar ocupado o haber quedado en un estado anterior. Use Reiniciar sesión Serial.',
      InvalidStateError:'El puerto se encuentra en un estado inconsistente. Se reinició la sesión Serial.',
      AbortError:'Operación Serial cancelada.',TimeoutError:error.message};
    const text=map[error.name]||`Error de conexión: ${error.message||'desconocido'}`;
    if(!['NotFoundError','AbortError'].includes(error.name))this.incrementError(); await this.cleanupSerialConnection(`error-${error.name}`,{keepUI:true});
    this.connectionState(error.name==='SecurityError'?'policy':error.name==='NetworkError'?'busy':'disconnected'); this.message(text);
    this.log(['NotFoundError','AbortError'].includes(error.name)?'system':'error',text); if(['NotFoundError','AbortError'].includes(error.name))this.toast(text);
  }
  async resetSerialSession() {
    if(this.connectionInProgress)return;
    this.connectionInProgress=true; this.setConnectionControlsBusy(true);
    try { await this.cleanupSerialConnection('user-reset'); this.message('Sesión Serial reiniciada. Comprobando puertos autorizados…'); await this.runDiagnostics({preserveMessage:true}); this.message('Sesión Serial limpia. Puede reconectar o buscar dispositivo.'); }
    finally { this.connectionInProgress=false; this.setConnectionControlsBusy(false); }
  }
  async testPing() {
    if(!this.portIsOpen||!this.writer||this.connectionInProgress)return this.toast('Abra primero un puerto Serial.');
    this.e.testPingBtn.disabled=true; this.message('Probando PING…');
    const pong=this.waitForPong(2000);
    const sent=await this.sendRaw('PING');
    const latency=sent?await pong:null;
    if(latency==null){this.check('checkFirmware',false,'Firmware responde');this.check('checkArduino',false,'Arduino');this.message('Sin respuesta. Revise firmware, baud rate y monitor Serial.');this.log('error','TIMEOUT → sin respuesta');}
    else{const infoPromise=this.waitForFirmwareInfo(1600);await this.sendRaw('GET:INFO');const info=await infoPromise;this.firmwareManager?.setFirmwareInfo(info);if(info?.firmware==='HW-WORKBENCH'){this.e.latency.textContent=`${Math.round(latency)} ms`;this.check('checkFirmware',true,'Firmware responde');this.setHardwareReady(true);this.connectionState('connected');this.message('PING/PONG y versión correctos. Arduino operativo.');}else{this.connectionState('incompatible');this.message('PING respondió, pero el firmware no es HW-WORKBENCH compatible.');}}
    this.e.testPingBtn.disabled=this.hardwareReady||!this.portIsOpen;
  }
  async forgetOrChangeDevice() {
    if(this.connectionInProgress)return;
    const candidate=this.port||this.authorizedPorts[0];
    if(!candidate||typeof candidate.forget!=='function'){
      this.message('Para cambiar permisos del puerto, utilice Buscar dispositivo o los permisos del sitio de Chrome.'); return;
    }
    this.connectionInProgress=true; this.setConnectionControlsBusy(true);
    try { await this.cleanupSerialConnection('forget-device'); await candidate.forget(); this.authorizedPorts=[]; this.check('checkAuthorized',false,'Puerto autorizado'); this.message('Permiso del puerto eliminado. Pulse Buscar dispositivo para seleccionar otro.'); }
    catch(error){this.serialError(error,'forget');this.message('No se pudo olvidar el puerto. Utilice los permisos del sitio de Chrome/Edge.');}
    finally { this.connectionInProgress=false; this.setConnectionControlsBusy(false); }
  }
  setConnectionControlsBusy(busy) {
    this.e.connectBtn.disabled=busy;
    this.e.searchDeviceBtn.disabled=busy||this.portIsOpen||!('serial' in navigator)||!window.isSecureContext||this.isEmbedded();
    this.e.reconnectBtn.disabled=busy||this.portIsOpen||!this.authorizedPorts.length;
    this.e.testPingBtn.disabled=busy||!this.portIsOpen||this.hardwareReady;
  }
  connectionState(state) {
    const states={disconnected:['offline','Desconectado'],searching:['offline','Buscando Arduino...'],selected:['offline','Arduino seleccionado'],
      opening:['offline','Abriendo puerto...'],initializing:['offline','Inicializando Arduino...'],verifying:['offline','Verificando firmware...'],
      connected:['online','Arduino conectado'],incompatible:['error','Firmware no compatible'],'firmware-timeout':['error','Firmware sin respuesta'],busy:['error','Puerto ocupado'],policy:['error','Política bloqueó Serial']};
    this.connectionStateName=state; const [kind,text]=states[state]||['error','Error']; this.setStatus(kind,text);
    this.e.connectBtn.textContent=this.portIsOpen?'Desconectar':'Conectar dispositivo';
    this.e.baudRate.disabled=this.portIsOpen||!['disconnected','busy','policy','firmware-timeout'].includes(state);
  }
  async disconnect(options={}) {
    await this.cleanupSerialConnection('manual-disconnect'); this.connectionState('disconnected');
    if(!options.preserve)this.log('system','Puerto desconectado y recursos liberados.');
  }
  async cleanupSerialConnection(reason='unspecified',options={}) {
    if(this.cleanupInProgress)return this.cleanupInProgress;
    this.cleanupInProgress=(async()=>{
      this.serialLog(`cleanup started (${reason})`); this.stressCancelled=true; this.keepReading=false;
      this.pendingPings.forEach(p=>p.finish(null)); this.pendingPings.clear();this.pendingFirmwareInfo.forEach(p=>p.finish(null));this.pendingFirmwareInfo.clear();
      try{if(this.reader)await withTimeout(this.reader.cancel(),1200,'Timeout cancelando reader.');}catch(error){this.serialError(error,'reader cancel');}
      try{this.reader?.releaseLock();this.serialLog('reader released');}catch(error){this.serialError(error,'reader release');} this.reader=null;
      try{if(this.readableClosed)await withTimeout(this.readableClosed,1200,'Timeout cerrando readable.');}catch{} this.readableClosed=null;
      try{if(this.writer)await withTimeout(this.writer.close(),1200,'Timeout cerrando writer.');}catch(error){this.serialError(error,'writer close');}
      try{this.writer?.releaseLock();this.serialLog('writer released');}catch(error){this.serialError(error,'writer release');} this.writer=null;
      try{if(this.writableClosed)await withTimeout(this.writableClosed,1200,'Timeout cerrando writable.');}catch{} this.writableClosed=null;
      if(this.portIsOpen){try{await withTimeout(this.port?.close(),1500,'Timeout cerrando puerto.');this.serialLog('port closed');}catch(error){this.serialError(error,'port close');}}
      this.portIsOpen=false; this.port=null; this.buffer=''; this.commitTime(); this.setHardwareReady(false);
      this.check('checkPortOpen',false,'Puerto abierto'); this.check('checkFirmware',false,'Firmware responde');
      if(!options.keepUI)this.connectionState('disconnected'); this.serialLog('cleanup complete');
      this.firmwareManager?.refreshPort();
    })().finally(()=>{this.cleanupInProgress=null;});
    return this.cleanupInProgress;
  }
  async unexpectedDisconnect(){this.serialLog('physical disconnect');this.incrementError();this.message('Arduino desconectado físicamente.');await this.cleanupSerialConnection('physical-disconnect');this.check('checkUsbDevice',false,'Dispositivo USB');void this.runDiagnostics({preserveMessage:true});}

  async readLoop() {
    try { while(this.keepReading&&this.reader&&this.port?.readable){const {value,done}=await this.reader.read();if(done)break;this.processReceivedChunk(this.decoder.decode(value,{stream:true}));} }
    catch(error){if(this.keepReading){this.incrementError();this.serialError(error,'read loop');this.log('error',`Lectura serial: ${error.message}`);void this.cleanupSerialConnection('read-error');}}
  }
  processReceivedChunk(chunk) {
    console.debug('[SERIAL RX RAW]',JSON.stringify(chunk)); this.buffer+=chunk;
    const lines=this.buffer.split(/\n/); this.buffer=lines.pop()||'';
    for(const rawLine of lines){const line=rawLine.replace(/\r$/,'').trim();if(line)this.handleMessage(line);}
  }
  handleMessage(line) {
    this.e.rxCount.textContent=String(Number(this.e.rxCount.textContent)+1); if(!this.paused)this.log('rx',line);
    let pong=/(^|\b)PONG(\b|$)/i.test(line), parsed=false;
    try { const data=JSON.parse(line); if(data.temp!=null)this.e.tempReading.textContent=`${data.temp.toFixed?.(1)??data.temp} °C`;
      if(data.humidity!=null)this.e.humidityReading.textContent=`${data.humidity.toFixed?.(1)??data.humidity} % RH`;
      if(data.distance!=null)this.e.distanceReading.textContent=`${data.distance} cm`; if(data.ldr!=null)this.e.ldrReading.textContent=`${data.ldr} / 1023`;
      parsed=true; pong ||= data.command==='PING'||data.event==='pong';
      if(data.event==='ready'){this.log('system','Arduino iniciado');this.message(`Arduino iniciado${data.device?` (${data.device})`:''}. Verificando PING/PONG…`);}
      if(data.command==='GET:INFO'||data.firmware){const pending=this.pendingFirmwareInfo.values().next().value;if(pending)pending.finish(data);}
      if(data.ok===true&&data.command&&data.command!=='PING')this.e.hardwareHint.textContent=`Confirmado por Arduino: ${data.command}`;
      if(data.angle!=null)this.e.servoValue.textContent=`${data.angle}°`;
      if(data.speed!=null)this.e.motorValue.textContent=`${data.speed}%`;
      if(data.ok===false)this.registerError(data.error||'Error informado por firmware',false);
    } catch{}
    if(!parsed)this.log('system',`RX RAW ← ${line}`);
    if(pong){this.serialLog('PONG received');const pending=this.pendingPings.values().next().value;if(pending)pending.finish(performance.now()-pending.started);}
  }
  waitForPong(ms=TIMEOUT) { return new Promise(resolve=>{const p={started:performance.now(),done:false,timer:null,finish:value=>{if(p.done)return;p.done=true;clearTimeout(p.timer);this.pendingPings.delete(p);resolve(value);}};p.timer=setTimeout(()=>p.finish(null),ms);this.pendingPings.add(p);}); }
  waitForFirmwareInfo(ms=1600){return new Promise(resolve=>{const p={done:false,timer:null,finish:value=>{if(p.done)return;p.done=true;clearTimeout(p.timer);this.pendingFirmwareInfo.delete(p);resolve(value);}};p.timer=setTimeout(()=>p.finish(null),ms);this.pendingFirmwareInfo.add(p);});}
  async send(command,component='') {
    command=String(command||'').trim();if(!command)return false;
    if(!this.hardwareReady){this.toast('Conecte un Arduino para utilizar este control.');this.log('error',`No enviado: ${command}`);return false;}
    const sent=await this.sendRaw(command);if(sent&&component){this.metrics.cycles++;this.saveMetrics();this.renderMetrics();}return sent;
  }
  async sendRaw(command) { if(!this.writer||!this.port||!this.portIsOpen)return false;const payload=`${command}\n`;console.debug('[SERIAL TX RAW]',JSON.stringify(payload));try{await withTimeout(this.writer.write(new TextEncoder().encode(payload)));this.e.txCount.textContent=String(Number(this.e.txCount.textContent)+1);this.log('tx',command);return true;}catch(error){this.registerError(`Escritura serial: ${error.message}`);this.serialError(error,'write');if(this.hardwareReady)void this.cleanupSerialConnection('write-error');return false;} }

  async runStressTest() {
    if(!this.hardwareReady)return this.toast('Conecte un Arduino para utilizar este control.');
    this.stressCancelled=false;this.e.stressBtn.disabled=true;this.e.cancelStressBtn.hidden=false;const samples=[];let success=0;
    for(let i=1;i<=10&&!this.stressCancelled&&this.hardwareReady;i++){this.e.stressStatus.textContent=`Prueba ${i} de 10…`;this.e.stressProgress.style.width=`${i*10}%`;const pong=this.waitForPong(1200);if(await this.send('PING','STRESS')){const latency=await pong;if(latency!=null){samples.push(latency);success++;}}await delay(100);}
    const avg=samples.length?Math.round(samples.reduce((a,b)=>a+b,0)/samples.length):null;
    const min=samples.length?Math.round(Math.min(...samples)):null,max=samples.length?Math.round(Math.max(...samples)):null;this.e.latency.textContent=avg==null?'Timeout':`${avg} ms`;
    this.e.stressStatus.textContent=this.stressCancelled?'Stress Test cancelado':`${success}/10 · ${avg==null?'sin respuesta':`mín ${min} · máx ${max} · prom ${avg} ms`}`;
    if(!this.stressCancelled&&success<10){this.metrics.errors+=10-success;this.saveMetrics();this.renderMetrics();}this.e.cancelStressBtn.hidden=true;this.e.stressBtn.disabled=!this.hardwareReady;
  }
  setHardwareReady(ready) {
    this.hardwareReady=ready;document.querySelectorAll('[data-hardware-control]').forEach(control=>{control.disabled=!ready;control.title=ready?'':'Conecte un Arduino para utilizar este control.';control.setAttribute('aria-disabled',String(!ready));});
    if(this.e.commandInput){this.e.commandInput.disabled=!ready;this.e.commandInput.placeholder=ready?'Escribe un comando, ej. GET:TEMP':'Conecte un Arduino para enviar comandos';}
    if(this.e.hardwareHint)this.e.hardwareHint.textContent=ready?'Arduino verificado · Controles habilitados':'Conecte un Arduino para utilizar estos controles.';
    if(this.e.stressStatus&&!ready)this.e.stressStatus.textContent='Conecte un Arduino para utilizar este control.';this.check('checkArduino',ready,'Arduino');
  }

  loadMetrics(){try{return{cycles:0,operationMs:0,errors:0,...JSON.parse(localStorage.getItem('hw-metrics')||'{}')}}catch(error){console.warn(error);return{cycles:0,operationMs:0,errors:0}}}
  saveMetrics(){try{localStorage.setItem('hw-metrics',JSON.stringify(this.metrics));}catch(error){console.warn(error);}}
  incrementError(){this.metrics.errors++;this.saveMetrics();this.renderMetrics();} registerError(message,log=true){this.incrementError();if(log)this.log('error',message);}
  commitTime(){if(this.operationStartedAt){this.metrics.operationMs+=Date.now()-this.operationStartedAt;this.operationStartedAt=null;this.saveMetrics();}}
  totalTime(){return this.metrics.operationMs+(this.operationStartedAt?Date.now()-this.operationStartedAt:0)}
  health(){return Math.max(0,Math.round(100-this.metrics.cycles/10000*60-this.totalTime()/3600000*.5-this.metrics.errors*2))}
  renderMetrics(){if(!this.e.healthScore)return;const h=this.health();this.e.cycleCount.textContent=this.metrics.cycles.toLocaleString('es');this.e.errorCount.textContent=String(this.metrics.errors);this.e.operationTime.textContent=this.duration(this.totalTime());this.e.healthPercent.textContent=`${h}%`;this.e.healthScore.style.setProperty('--score',`${h}%`);this.e.healthScore.className=`health-score ${h>=80?'optimal':h>=50?'wear':'critical'}`;this.e.healthState.textContent=h>=80?'ÓPTIMO':h>=50?'DESGASTE':'CRÍTICO';}
  startTimer(){if(this.sessionTimer)return;const update=()=>{this.e.sessionTime.textContent=this.duration(Date.now()-this.sessionStartedAt);if(this.operationStartedAt)this.renderMetrics();};update();this.sessionTimer=setInterval(update,1000);}
  stopTimer(){clearInterval(this.sessionTimer);this.sessionTimer=null;} duration(ms){const s=Math.floor(ms/1000);return[Math.floor(s/3600),Math.floor(s/60)%60,s%60].map(n=>String(n).padStart(2,'0')).join(':');}

  activateTab(tab){document.querySelectorAll('.tab').forEach(x=>x.classList.toggle('active',x===tab));document.querySelectorAll('.tab-panel').forEach(x=>x.classList.toggle('active',x.id===tab.dataset.tab));}
  linkRange(input,output,format){this.on(input,'input',event=>{this.e[output].textContent=format(event.target.value);});} on(id,event,handler){if(!this.e[id])throw new Error(`Falta #${id}`);this.e[id].addEventListener(event,handler);}
  require(ids){const missing=ids.filter(id=>!this.e[id]);if(missing.length)throw new Error(`Faltan elementos: ${missing.join(', ')}`);}
  setStatus(kind,text){if(!this.e.statusBadge)return;this.e.statusBadge.className=`status ${kind}`;this.e.statusBadge.querySelector('span').textContent=text;}
  startup(text){if(this.e.startupStatus)this.e.startupStatus.textContent=text;} message(text){if(this.e.diagnosticMessage)this.e.diagnosticMessage.textContent=text;}
  check(id,ok,label){if(!this.e[id])return;this.e[id].className=ok?'ok':'pending';this.e[id].innerHTML=`<span>${ok?'✓':'○'}</span> ${label}`;}
  showInitError(module,error){if(!this.e.initErrorCard)return;this.e.initErrorCard.hidden=false;this.e.initErrorModule.textContent=module;this.e.initErrorMessage.textContent=error?.message||String(error);}
  serialLog(message){console.info(`[SERIAL] ${message}`);}
  serialError(error,context=''){console.error(`[SERIAL ERROR]${context?` ${context}`:''}`,error?.name||'Error',error?.message||error);}
  log(type,message){if(!this.e.terminal)return;const line=document.createElement('div');line.className=`line ${type}`;const time=document.createElement('time');time.textContent=new Date().toLocaleTimeString('es',{hour12:false});const span=document.createElement('span');span.textContent=message;line.append(time,span);this.e.terminal.append(line);while(this.e.terminal.childElementCount>500)this.e.terminal.firstElementChild.remove();if(this.e.autoscroll?.checked)this.e.terminal.scrollTop=this.e.terminal.scrollHeight;}
  toast(message){if(!this.e.toast)return;this.e.toast.textContent=message;this.e.toast.classList.add('show');clearTimeout(this.toastTimer);this.toastTimer=setTimeout(()=>this.e.toast.classList.remove('show'),2600);}
}

let app;
async function initializeApp(){if(app)return;app=new SerialWorkbench();window.serialWorkbench=app;await app.initialize();}
window.addEventListener('error',event=>{console.error('[Error global]',event.error||event.message);app?.showInitError('JavaScript',event.error||new Error(event.message));});
window.addEventListener('unhandledrejection',event=>{console.error('[Promesa rechazada]',event.reason);app?.showInitError('Operación asíncrona',event.reason instanceof Error?event.reason:new Error(String(event.reason)));});
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',initializeApp,{once:true});else void initializeApp();
export {SerialWorkbench,initializeApp,withTimeout};
