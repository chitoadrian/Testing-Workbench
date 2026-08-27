const TIMEOUT = 2500;
const BUILD_VERSION = window.__HW_BUILD_VERSION__ || 'dev';
const RESET_DELAY = 1800;
const RECOVERY_DELAYS = [400, 900, 1500];
const SERIAL_LOCK_NAME = 'testing-workbench-serial-port';
const SERIAL_CHANNEL_NAME = 'testing-workbench-serial-coordination';
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
      connectionInProgress: false, portIsOpen: false, cleanupInProgress: null, recoveryInProgress: null,
      connectionStateName: 'disconnected', lastPortInfo: null, lastPortReference: null, externalPortBusy: false,
      serialChannel: null, remoteSerialOwner: null, ownsSerialTabLock: false, serialLockRelease: null,
      serialLockTask: null, takeoverRequest: null, lifecycleClosing: false, recoveryDelays: [...RECOVERY_DELAYS] });
    this.tabId = globalThis.crypto?.randomUUID?.() || `tab-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    this.pendingPings = new Set();
    this.pendingFirmwareInfo = new Set();
    this.decoder = new TextDecoder();
    this.metrics = { cycles: 0, operationMs: 0, errors: 0 };
    this.registeredListeners = new Set();
    this.e = this.cacheElements();
  }

  cacheElements() {
    const ids = ['baudRate','connectBtn','statusBadge','sessionTime','rxCount','txCount','latency','startupStatus',
      'diagnosticMessage','searchDeviceBtn','reconnectBtn','retryDiagnosticsBtn','checkInterface','checkJavaScript',
      'checkUiControls','checkWebSerial','checkSecureContext','checkFirmwareResources','checkUsbDevice','checkAuthorized','checkPortOpen','checkFirmware','checkArduino','environmentInfo',
      'testPingBtn','recoverSerialBtn','takeControlBtn','resetSerialBtn','forgetDeviceBtn','initErrorCard','initErrorModule','initErrorMessage','retryInitBtn',
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
      catch (error) { console.error(`[INIT ERROR] ${name}: ${error?.message||error}`); this.showInitError(name, error); }
    }
    this.startup('Interfaz lista');
    window.__HW_WORKBENCH_READY__ = true;
    await this.runDiagnostics();
  }

  initUI() {
    this.require(['connectBtn','statusBadge','startupStatus','toast']);
    this.check('checkInterface', true, 'Interfaz'); this.check('checkJavaScript', true, 'JavaScript');
    this.setHardwareReady(false);
    this.on('connectBtn','click', () => this.portIsOpen ? this.disconnect() : this.connectSelectedOrPick());
    this.on('baudRate','change', () => { if(this.e.baudRate.value!=='115200')this.toast('El firmware actual utiliza 115200.'); });
    this.on('retryInitBtn','click', () => { this.e.initErrorCard.hidden = true; void this.runDiagnostics(); });
  }
  initSerial() {
    this.initSerialCoordination();
    if ('serial' in navigator) {
      navigator.serial.addEventListener('disconnect', event => {
        if (event.target === this.port) void this.unexpectedDisconnect();
        else void this.runDiagnostics();
      });
      navigator.serial.addEventListener('connect', () => {
        this.serialLog('Dispositivo Serial detectado');
        this.log('system','Arduino USB detectado');
        this.check('checkUsbDevice',true,'Dispositivo USB');
        this.message('Dispositivo Serial detectado. Pulse Buscar dispositivo o Reconectar.');
        void this.runDiagnostics({preserveMessage:true});
      });
    }
    window.addEventListener('pagehide', () => this.bestEffortPageExit('pagehide'));
    window.addEventListener('beforeunload', () => this.bestEffortPageExit('beforeunload'));
    window.addEventListener('pageshow', event => {if(event.persisted){this.lifecycleClosing=false;if(!this.serialChannel)this.initSerialCoordination();void this.runDiagnostics({preserveMessage:true});}});
  }
  initSerialCoordination() {
    if (typeof BroadcastChannel !== 'function') return;
    try {
      this.serialChannel=new BroadcastChannel(SERIAL_CHANNEL_NAME);
      this.serialChannel.addEventListener('message',event=>this.handleSerialCoordinationMessage(event.data));
      this.broadcastSerial({type:'ownership-query'});
    } catch(error) { console.warn('[SERIAL COORDINATION] BroadcastChannel no disponible.',error);this.serialChannel=null; }
  }
  broadcastSerial(message) { try{this.serialChannel?.postMessage({...message,from:this.tabId,build:BUILD_VERSION});}catch(error){console.warn('[SERIAL COORDINATION] No se pudo publicar.',error);} }
  handleSerialCoordinationMessage(message) {
    if(!message||message.from===this.tabId)return;
    if(message.type==='ownership-query'&&this.ownsSerialTabLock)this.broadcastSerial({type:'ownership-acquired'});
    if(message.type==='ownership-acquired'){
      this.remoteSerialOwner=message.from;this.e.takeControlBtn.hidden=false;
      if(!this.ownsSerialTabLock){this.connectionState('tab-busy');this.message('El Arduino está siendo utilizado por otra pestaña de Testing Workbench.');}
    }
    if(message.type==='ownership-released'&&this.remoteSerialOwner===message.from){this.remoteSerialOwner=null;this.e.takeControlBtn.hidden=true;}
    if(message.type==='takeover-request'&&(!message.to||message.to===this.tabId)&&this.ownsSerialTabLock){
      if(this.firmwareManager?.busy){this.broadcastSerial({type:'takeover-denied',to:message.from,reason:'Instalación de firmware en curso'});return;}
      this.message('Otra pestaña solicitó el control. Liberando voluntariamente el puerto Serial…');
      void this.disconnect({preserve:true}).then(()=>this.broadcastSerial({type:'takeover-approved',to:message.from}));
    }
    if(message.to===this.tabId&&message.type==='takeover-approved')this.takeoverRequest?.finish(true);
    if(message.to===this.tabId&&message.type==='takeover-denied')this.takeoverRequest?.finish(false,message.reason);
  }
  async acquireSerialOwnership() {
    if(this.ownsSerialTabLock)return true;
    if(navigator.locks?.request){
      let announce;
      const availability=new Promise(resolve=>{announce=resolve;});
      this.serialLockTask=navigator.locks.request(SERIAL_LOCK_NAME,{mode:'exclusive',ifAvailable:true},async lock=>{
        if(!lock){announce(false);return;}
        this.ownsSerialTabLock=true;this.remoteSerialOwner=null;this.broadcastSerial({type:'ownership-acquired'});announce(true);
        await new Promise(resolve=>{this.serialLockRelease=resolve;});
        this.serialLockRelease=null;this.ownsSerialTabLock=false;this.broadcastSerial({type:'ownership-released'});
      }).catch(error=>{console.error('[SERIAL COORDINATION] Web Lock error',error);announce(false);});
      return withTimeout(availability,1000,'No se pudo coordinar el puerto con otras pestañas.').catch(()=>false);
    }
    this.broadcastSerial({type:'ownership-query'});await delay(180);
    if(this.remoteSerialOwner)return false;
    this.ownsSerialTabLock=true;this.broadcastSerial({type:'ownership-acquired'});return true;
  }
  async releaseSerialOwnership() {
    if(!this.ownsSerialTabLock&&!this.serialLockRelease)return;
    const release=this.serialLockRelease;this.serialLockRelease=null;this.ownsSerialTabLock=false;
    try{release?.();}catch(error){console.warn('[SERIAL COORDINATION] Error liberando Web Lock.',error);}
    this.broadcastSerial({type:'ownership-released'});await delay(0);
  }
  async takeSerialControl() {
    if(this.connectionInProgress)return this.toast('Operación en curso, espere…');
    if(!this.remoteSerialOwner)return this.recoverAndReconnect();
    this.message('Solicitando a la otra pestaña que libere voluntariamente el Arduino…');
    const result=await new Promise(resolve=>{
      const request={done:false,timer:null,finish:(ok,reason='')=>{if(request.done)return;request.done=true;clearTimeout(request.timer);this.takeoverRequest=null;resolve({ok,reason});}};
      request.timer=setTimeout(()=>request.finish(false,'La otra pestaña no respondió.'),3500);this.takeoverRequest=request;
      this.broadcastSerial({type:'takeover-request',to:this.remoteSerialOwner});
    });
    if(!result.ok)return this.message(`No se pudo tomar control: ${result.reason} Cierre la otra pestaña o libere el puerto allí.`);
    this.remoteSerialOwner=null;this.e.takeControlBtn.hidden=true;await delay(250);return this.recoverAndReconnect();
  }
  bestEffortPageExit(reason) {
    if(this.lifecycleClosing)return;this.lifecycleClosing=true;this.keepReading=false;this.stressCancelled=true;
    try{void this.reader?.cancel();}catch{}
    try{this.reader?.releaseLock();}catch{}
    try{this.writer?.releaseLock();}catch{}
    try{void this.port?.close();}catch{}
    try{this.serialLockRelease?.();}catch{}
    this.broadcastSerial({type:'ownership-released',reason});
    try{this.serialChannel?.close();this.serialChannel=null;}catch{}
    void this.cleanupSerialConnection(reason,{keepUI:true,unload:true});
  }
  async initFirmwareManager(){const module=await import(`./firmware-manager.js?v=${encodeURIComponent(BUILD_VERSION)}`);this.firmwareManager=new module.FirmwareManager(this);this.firmwareManager.init();this.registeredListeners.add('installFirmwareBtn:click');this.registeredListeners.add('firmwareBoard:change');}
  initDiagnostics() {
    this.require(['searchDeviceBtn','reconnectBtn','testPingBtn','recoverSerialBtn','takeControlBtn','resetSerialBtn','forgetDeviceBtn','retryDiagnosticsBtn','diagnosticMessage']);
    this.on('searchDeviceBtn','click', () => this.connectWithPicker());
    this.on('reconnectBtn','click', () => this.reconnectAuthorized());
    this.on('testPingBtn','click', () => this.testPing());
    this.on('recoverSerialBtn','click', () => this.recoverAndReconnect());
    this.on('takeControlBtn','click', () => this.takeSerialControl());
    this.on('resetSerialBtn','click', () => this.resetSerialSession());
    this.on('forgetDeviceBtn','click', () => this.forgetOrChangeDevice());
    this.on('retryDiagnosticsBtn','click', () => this.runDiagnostics());
  }
  initGallery() {
    document.querySelectorAll('.tab').forEach(tab => {tab.addEventListener('click', () => this.activateTab(tab));this.registeredListeners.add(`tab:${tab.dataset.tab}:click`);});
    document.querySelectorAll('[data-command]').forEach(button => {
      button.dataset.hardwareControl = '';
      button.addEventListener('click', () => this.send(button.dataset.command, button.dataset.component));this.registeredListeners.add(`command:${button.dataset.command}:click`);
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
    this.on('commandForm','submit', event => { event.preventDefault(); const value=this.e.commandInput.value; this.e.commandInput.value=''; void this.send(value); });
    this.on('clearBtn','click', () => this.e.terminal.replaceChildren());
    this.on('pauseBtn','click', () => { this.paused=!this.paused; this.e.pauseBtn.textContent=this.paused?'Reanudar':'Pausar'; });
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
    const ui=this.auditUiControls();this.checkResult('checkUiControls',ui.ok,'Controles UI',ui.failures.join(', '));
    const resources=await this.checkFirmwareResources();this.checkResult('checkFirmwareResources',resources.ok,'Recursos firmware',resources.failures.join(', '));
    this.renderEnvironment();
    this.checkResult('checkWebSerial',serial,'Web Serial',serial?'':'no disponible'); this.checkResult('checkSecureContext',secure,'Contexto seguro',file?'archivo local':secure?'':'requiere HTTPS o localhost');
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
      const detected=authorized||Boolean(this.port);
      this.check('checkUsbDevice',detected,'Dispositivo USB');
      if(authorized){this.rememberPort(this.authorizedPorts[0]);this.serialLog(`Arduino USB detectado${this.portLabel(this.authorizedPorts[0])?` · ${this.portLabel(this.authorizedPorts[0])}`:''}`);}
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
  browser() { const ua=navigator.userAgent; const match=ua.match(/(?:Edg|Chrome|Chromium)\/(\d+)/);const name=/Edg\//.test(ua)?'Microsoft Edge':/Chrome\//.test(ua)?'Google Chrome':/Chromium\//.test(ua)?'Chromium':'otro';return `${name}${match?` ${match[1]}`:''}`; }
  system(){const ua=navigator.userAgent;return /Windows/i.test(ua)?'Windows':/Mac OS/i.test(ua)?'macOS':/Linux/i.test(ua)?'Linux':'otro';}
  renderEnvironment(){if(this.e.environmentInfo)this.e.environmentInfo.textContent=`Navegador: ${this.browser()} · Sistema: ${this.system()} · Contexto: ${location.protocol.replace(':','')||'desconocido'} · Build ${BUILD_VERSION}`;}
  auditUiControls(){const required=new Set(['connectBtn:click','searchDeviceBtn:click','reconnectBtn:click','testPingBtn:click','resetSerialBtn:click','retryDiagnosticsBtn:click','commandForm:submit','clearBtn:click','pauseBtn:click','resetMetrics:click','stressBtn:click','pwmSlider:input','toneSlider:input','servoSlider:input','motorSlider:input','installFirmwareBtn:click','firmwareBoard:change','tab:actuators:click','tab:sensors:click','tab:motors:click']);document.querySelectorAll('button,input,select,form').forEach(control=>{if(control.matches?.('[data-command]'))required.add(`command:${control.dataset.command}:click`);else if(control.matches?.('.tab'))required.add(`tab:${control.dataset.tab}:click`);else if(control.tagName==='BUTTON'&&control.id)required.add(`${control.id}:click`);else if(control.tagName==='INPUT'&&control.type==='range')required.add(`${control.id}:input`);else if(control.tagName==='SELECT')required.add(`${control.id}:change`);else if(control.tagName==='FORM')required.add(`${control.id}:submit`);});const failures=[...required].filter(key=>!this.registeredListeners.has(key));return{ok:failures.length===0,failures};}
  async checkFirmwareResources(){const paths=['./firmware/manifest.json','./firmware/uno/testing-workbench.hex','./firmware/mega/testing-workbench.hex'],failures=[];for(const path of paths){try{const response=await withTimeout(fetch(path,{method:'HEAD',cache:'no-store'}),2500,`Timeout: ${path}`);if(!response.ok)failures.push(`${path} (${response.status})`);}catch(error){failures.push(`${path} (${error.name||'error'})`);}}return{ok:failures.length===0,failures};}
  isEmbedded() { try{return window.self!==window.top;}catch(error){console.warn('No se pudo comprobar el iframe.',error);return true;} }
  portInfo(port){try{return port?.getInfo?.()||{};}catch{return{};}}
  rememberPort(port){if(!port)return;this.lastPortReference=port;const info=this.portInfo(port);this.lastPortInfo={usbVendorId:info.usbVendorId,usbProductId:info.usbProductId};}
  samePort(candidate,reference=this.lastPortInfo){if(!candidate||!reference)return candidate===this.lastPortReference;const info=this.portInfo(candidate);if(reference.usbVendorId==null&&reference.usbProductId==null)return candidate===this.lastPortReference;return info.usbVendorId===reference.usbVendorId&&info.usbProductId===reference.usbProductId;}
  portLabel(port){const info=this.portInfo(port),vid=info.usbVendorId?.toString(16).toUpperCase().padStart(4,'0'),pid=info.usbProductId?.toString(16).toUpperCase().padStart(4,'0');if(!vid||!pid)return'';return info.usbVendorId===0x2341&&info.usbProductId===0x0043?`Arduino Uno · USB ${vid}:${pid}`:`USB ${vid}:${pid}`;}
  canInstallFirmware(){return Boolean(this.port&&this.portIsOpen&&this.writer&&this.ownsSerialTabLock&&!this.externalPortBusy&&!this.recoveryInProgress);}

  async connectSelectedOrPick() {
    if(this.connectionInProgress)return this.toast('Operación en curso, espere...');
    const candidate=this.port||this.authorizedPorts[0];
    if(!candidate)return this.connectWithPicker();
    return this.connectPort(candidate,true);
  }
  async connectWithPicker() {
    if(this.connectionInProgress)return this.toast('Operación en curso, espere...');
    if (!('serial' in navigator)) return this.diagnosticStop('Este navegador no tiene Web Serial disponible. Utilice una versión actual de Chrome o Edge.');
    if (!window.isSecureContext||location.protocol==='file:'||this.isEmbedded()) return this.runDiagnostics();
    this.connectionInProgress=true; this.setConnectionControlsBusy(true); this.connectionState('searching');
    this.serialLog('requestPort start');
    const cleanupPromise=this.cleanupSerialConnection('change-device',{keepUI:true});
    try {
      // Primer await del clic: siempre abre una selección real y conserva la activación del usuario.
      const newPort=await navigator.serial.requestPort();
      await cleanupPromise; this.port=newPort;this.rememberPort(newPort);this.serialLog(`port selected${this.portLabel(newPort)?` · ${this.portLabel(newPort)}`:''}`);
      this.firmwareManager?.refreshPort();
      this.check('checkUsbDevice',true,'Dispositivo USB'); this.check('checkAuthorized',true,'Puerto autorizado');
      this.connectionState('selected'); await this.openPort();
    } catch(error) { await cleanupPromise; await this.connectionError(error); }
    finally { this.connectionInProgress=false; this.setConnectionControlsBusy(false); }
  }
  async reconnectAuthorized() {
    if(this.connectionInProgress)return this.toast('Operación en curso, espere...');
    const candidate=this.authorizedPorts[0];
    if (!candidate) return this.toast('No hay un Arduino autorizado. Pulse Buscar dispositivo.');
    return this.connectPort(candidate,true);
  }
  async connectPort(candidate,isAuthorized=false) {
    if(this.connectionInProgress)return this.toast('Operación en curso, espere...');
    this.connectionInProgress=true; this.setConnectionControlsBusy(true);
    try { await this.cleanupSerialConnection('before-connect',{keepUI:true}); this.port=candidate;this.rememberPort(candidate); this.connectionState('selected'); await this.openPort(); }
    catch(error) { await this.connectionError(error,{stale:isAuthorized}); }
    finally { this.connectionInProgress=false; this.setConnectionControlsBusy(false); }
  }
  async openPort(options={}) {
    if(!this.port)throw new DOMException('No existe un puerto seleccionado.','InvalidStateError');
    this.rememberPort(this.port);
    if(!this.ownsSerialTabLock&&!options.skipOwnership){
      const acquired=await this.acquireSerialOwnership();
      if(!acquired){this.e.takeControlBtn.hidden=false;throw new DOMException('El Arduino está siendo utilizado por otra pestaña de Testing Workbench.','RemoteTabError');}
    }
    const baudRate=Number(this.e.baudRate.value),originalPort=this.port;
    let opened=false,lastError=null;
    for(let attempt=0;attempt<=this.recoveryDelays.length&&!opened;attempt++){
      if(attempt>0){
        const waitMs=this.recoveryDelays[attempt-1];this.connectionState('recovering');
        this.message(`Recuperando puerto Serial... intento ${attempt}/${this.recoveryDelays.length}`);this.recoveryLog(`Reintento ${attempt}/${this.recoveryDelays.length} · espera ${waitMs} ms`);
        const recovered=await this.recoverSerialPort({port:this.port||originalPort,waitMs,keepOwnership:true,attempt});
        if(!recovered)throw new DOMException('El puerto autorizado desapareció durante la recuperación.','NetworkError');
        this.port=recovered;this.rememberPort(recovered);
      }
      try{
        this.connectionState('opening');this.serialLog(`Intentando abrir puerto · ${baudRate} baud`);this.log('system',`Intentando abrir puerto · ${baudRate} baud`);
        await withTimeout(this.port.open({baudRate,bufferSize:4096}),5000,'La apertura del puerto tardó demasiado.');opened=true;
      }catch(error){
        lastError=error;this.serialError(error,'port.open');if(error.name==='NetworkError')this.log('system','NetworkError al abrir el puerto');
        if(error.name!=='NetworkError'||attempt===this.recoveryDelays.length)break;
        this.recoveryLog(`NetworkError · preparando recuperación ${attempt+1}/${this.recoveryDelays.length}`);
      }
    }
    if(!opened){
      if(lastError?.name==='NetworkError'){this.externalPortBusy=true;this.e.recoverSerialBtn.hidden=false;this.connectionState('external-busy');this.recoveryLog('Puerto continúa ocupado externamente');}
      throw lastError||new DOMException('No se pudo abrir el puerto.','NetworkError');
    }
    if(!this.port.readable||!this.port.writable)throw new DOMException('El puerto abrió sin streams de lectura/escritura.','NetworkError');
    this.externalPortBusy=false;this.e.recoverSerialBtn.hidden=true;this.e.takeControlBtn.hidden=true;
    this.portIsOpen=true; this.check('checkPortOpen',true,'Puerto abierto');this.connectionState('opened'); this.recoveryLog('Puerto abierto correctamente');
    this.reader=this.port.readable.getReader(); this.writer=this.port.writable.getWriter();
    this.keepReading=true; this.buffer=''; this.decoder=new TextDecoder(); this.operationStartedAt=Date.now(); this.serialLog('read loop started'); void this.readLoop();
    if(options.skipHandshake)return;
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
      NetworkError:'Puerto ocupado externamente. El Arduino fue detectado, pero Windows no permite abrir el puerto. Probablemente está siendo utilizado por otra pestaña, otra aplicación o quedó temporalmente bloqueado.',
      RemoteTabError:'El Arduino está siendo utilizado por otra pestaña de Testing Workbench.',
      InvalidStateError:'El puerto se encuentra en un estado inconsistente. Se reinició la sesión Serial.',
      AbortError:'Operación Serial cancelada.',TimeoutError:error.message};
    const text=map[error.name]||`Error de conexión: ${error.message||'desconocido'}`;
    if(!['NotFoundError','AbortError','RemoteTabError'].includes(error.name))this.incrementError();await this.cleanupSerialConnection(`error-${error.name}`,{keepUI:true});
    const state=error.name==='SecurityError'?'policy':error.name==='NetworkError'?'external-busy':error.name==='RemoteTabError'?'tab-busy':'disconnected';this.connectionState(state);this.message(text);
    this.e.recoverSerialBtn.hidden=error.name!=='NetworkError';this.e.takeControlBtn.hidden=error.name!=='RemoteTabError';
    this.log(['NotFoundError','AbortError'].includes(error.name)?'system':'error',text);if(['NotFoundError','AbortError'].includes(error.name))this.toast(text);
  }
  async resetSerialSession() {
    if(this.connectionInProgress)return this.toast('Operación en curso, espere...');
    this.connectionInProgress=true; this.setConnectionControlsBusy(true);
    try { await this.cleanupSerialConnection('user-reset',{recovery:true});await delay(500);this.authorizedPorts=await withTimeout(navigator.serial.getPorts(),2200,'No se pudieron consultar puertos autorizados.');this.externalPortBusy=false;this.e.recoverSerialBtn.hidden=true;this.check('checkAuthorized',this.authorizedPorts.length>0,'Puerto autorizado');this.connectionState('disconnected');this.message('Sesión Serial completamente reiniciada. Puede reconectar el Arduino.');this.log('system','Sesión Serial completamente reiniciada. Permisos autorizados conservados.');this.firmwareManager?.refreshPort(); }
    catch(error){this.serialError(error,'reset session');this.message(`La sesión se limpió, pero no se pudieron consultar los puertos: ${error.message}`);}
    finally { this.connectionInProgress=false; this.setConnectionControlsBusy(false); }
  }
  async testPing() {
    if(this.connectionInProgress)return this.toast('Operación en curso, espere...');
    if(!this.portIsOpen||!this.writer)return this.toast('Abra primero un puerto Serial.');
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
    this.e.recoverSerialBtn.disabled=busy;
    this.e.takeControlBtn.disabled=busy;
  }
  connectionState(state) {
    const states={disconnected:['offline','Desconectado'],searching:['pending','Buscando Arduino...'],detected:['pending','Arduino detectado'],authorized:['pending','Puerto autorizado'],selected:['pending','Arduino seleccionado'],
      opening:['pending','Abriendo puerto...'],recovering:['pending','Recuperando puerto...'],opened:['pending','Puerto abierto'],initializing:['pending','Inicializando Arduino...'],verifying:['pending','Verificando firmware...'],
      connected:['online','Arduino operativo'],incompatible:['error','Firmware no compatible'],'firmware-timeout':['warning','Firmware sin respuesta'],busy:['error','Puerto ocupado'],
      'external-busy':['error','Puerto ocupado externamente'],'tab-busy':['warning','Arduino en otra pestaña'],policy:['error','Política bloqueó Serial']};
    this.connectionStateName=state; const [kind,text]=states[state]||['error','Error']; this.setStatus(kind,text);
    this.e.connectBtn.textContent=this.portIsOpen?'Desconectar':'Conectar dispositivo';
    this.e.baudRate.disabled=this.portIsOpen||!['disconnected','busy','external-busy','tab-busy','policy','firmware-timeout'].includes(state);
  }
  async disconnect(options={}) {
    await this.cleanupSerialConnection('manual-disconnect');this.externalPortBusy=false;this.e.recoverSerialBtn.hidden=true;this.connectionState('disconnected');
    if(!options.preserve)this.log('system','Puerto desconectado y recursos liberados.');
  }
  async cleanupSerialConnection(reason='unspecified',options={}) {
    if(this.cleanupInProgress)return this.cleanupInProgress;
    this.cleanupInProgress=(async()=>{
      const recovery=Boolean(options.recovery),step=async(label,action)=>{if(recovery)this.recoveryLog(label);try{await action();}catch(error){if(recovery)this.recoveryError(label,error);else this.serialError(error,label);}};
      if(recovery)this.recoveryLog(`Limpieza profunda iniciada (${reason})`);else this.serialLog(`cleanup started (${reason})`);
      this.rememberPort(this.port||this.lastPortReference);this.stressCancelled=true;this.keepReading=false;
      this.pendingPings.forEach(p=>p.finish(null)); this.pendingPings.clear();this.pendingFirmwareInfo.forEach(p=>p.finish(null));this.pendingFirmwareInfo.clear();
      await step('Deteniendo lectura',async()=>{});
      await step('Cancelando reader',async()=>{if(this.reader)await withTimeout(this.reader.cancel(),1200,'Timeout cancelando reader.');});
      await step('Reader liberado',async()=>this.reader?.releaseLock());this.reader=null;
      await step('Esperando readableClosed',async()=>{if(this.readableClosed)await withTimeout(this.readableClosed,1200,'Timeout cerrando readable.');});this.readableClosed=null;
      await step('Cerrando writer',async()=>{if(this.writer)await withTimeout(this.writer.close(),1200,'Timeout cerrando writer.');});
      await step('Writer liberado',async()=>this.writer?.releaseLock());this.writer=null;
      await step('Esperando writableClosed',async()=>{if(this.writableClosed)await withTimeout(this.writableClosed,1200,'Timeout cerrando writable.');});this.writableClosed=null;
      const portMayBeOpen=Boolean(this.port&&(this.portIsOpen||this.port.readable||this.port.writable||options.forceClose));
      await step('Puerto cerrado',async()=>{if(portMayBeOpen)await withTimeout(this.port.close(),1500,'Timeout cerrando puerto.');});
      this.portIsOpen=false; this.port=null; this.buffer=''; this.commitTime(); this.setHardwareReady(false);
      this.check('checkPortOpen',false,'Puerto abierto'); this.check('checkFirmware',false,'Firmware responde');
      if(!options.keepOwnership)await step('Coordinación entre pestañas liberada',()=>this.releaseSerialOwnership());
      if(!options.keepUI)this.connectionState('disconnected'); if(recovery)this.recoveryLog('Limpieza profunda completada');else this.serialLog('cleanup complete');
      this.firmwareManager?.refreshPort();
    })().finally(()=>{this.cleanupInProgress=null;});
    return this.cleanupInProgress;
  }
  async recoverSerialPort(options={}) {
    if(this.recoveryInProgress)return this.recoveryInProgress;
    const target=options.port||this.port||this.lastPortReference||this.authorizedPorts[0];this.rememberPort(target);const reference={...this.lastPortInfo};
    this.recoveryInProgress=(async()=>{
      this.connectionState('recovering');this.recoveryLog(`Recuperando sesión Serial${options.attempt?` · intento ${options.attempt}/${this.recoveryDelays.length}`:''}`);
      await this.cleanupSerialConnection('serial-recovery',{keepUI:true,keepOwnership:Boolean(options.keepOwnership),recovery:true,forceClose:true});
      const waitMs=Number(options.waitMs??400);this.recoveryLog(`Esperando ${waitMs} ms para que Windows libere el puerto`);await delay(waitMs);
      this.recoveryLog('Consultando nuevamente puertos autorizados');
      this.authorizedPorts=await withTimeout(navigator.serial.getPorts(),2500,'No se pudieron consultar puertos autorizados durante la recuperación.');
      const recovered=this.authorizedPorts.find(port=>port===target)||this.authorizedPorts.find(port=>this.samePort(port,reference))||null;
      this.check('checkAuthorized',this.authorizedPorts.length>0,'Puerto autorizado');this.check('checkUsbDevice',Boolean(recovered),'Dispositivo USB');
      if(recovered){this.rememberPort(recovered);this.recoveryLog(`Puerto autorizado localizado${this.portLabel(recovered)?` · ${this.portLabel(recovered)}`:''}`);}
      else this.recoveryError('Localizar puerto','El dispositivo autorizado ya no está disponible.');
      this.firmwareManager?.refreshPort();return recovered;
    })().finally(()=>{this.recoveryInProgress=null;});
    return this.recoveryInProgress;
  }
  async recoverAndReconnect() {
    if(this.connectionInProgress||this.recoveryInProgress)return this.toast('La recuperación Serial ya está en curso.');
    this.connectionInProgress=true;this.setConnectionControlsBusy(true);
    try{
      const recovered=await this.recoverSerialPort({waitMs:400});
      if(!recovered)throw new DOMException('El Arduino autorizado ya no está disponible.','NotFoundError');
      this.port=recovered;this.connectionState('authorized');await this.openPort();
    }catch(error){await this.connectionError(error);}
    finally{this.connectionInProgress=false;this.setConnectionControlsBusy(false);}
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
    if(this.stressRunning)return this.toast('Stress Test en curso, espere...');
    if(!this.hardwareReady)return this.toast('Conecte un Arduino para utilizar este control.');
    this.stressRunning=true;this.stressCancelled=false;this.e.stressBtn.disabled=true;this.e.cancelStressBtn.hidden=false;const samples=[];let success=0;
    for(let i=1;i<=10&&!this.stressCancelled&&this.hardwareReady;i++){this.e.stressStatus.textContent=`Prueba ${i} de 10…`;this.e.stressProgress.style.width=`${i*10}%`;const pong=this.waitForPong(1200);if(await this.send('PING','STRESS')){const latency=await pong;if(latency!=null){samples.push(latency);success++;}}await delay(100);}
    const avg=samples.length?Math.round(samples.reduce((a,b)=>a+b,0)/samples.length):null;
    const min=samples.length?Math.round(Math.min(...samples)):null,max=samples.length?Math.round(Math.max(...samples)):null;this.e.latency.textContent=avg==null?'Timeout':`${avg} ms`;
    this.e.stressStatus.textContent=this.stressCancelled?'Stress Test cancelado':`${success}/10 · ${avg==null?'sin respuesta':`mín ${min} · máx ${max} · prom ${avg} ms`}`;
    if(!this.stressCancelled&&success<10){this.metrics.errors+=10-success;this.saveMetrics();this.renderMetrics();}this.stressRunning=false;this.e.cancelStressBtn.hidden=true;this.e.stressBtn.disabled=!this.hardwareReady;
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
  linkRange(input,output,format){this.on(input,'input',event=>{this.e[output].textContent=format(event.target.value);});} on(id,event,handler){if(!this.e[id])throw new Error(`Falta #${id}`);const key=`${id}:${event}`;if(this.registeredListeners.has(key))return;this.e[id].addEventListener(event,handler);this.registeredListeners.add(key);}
  require(ids){const missing=ids.filter(id=>!this.e[id]);if(missing.length)throw new Error(`Faltan elementos: ${missing.join(', ')}`);}
  setStatus(kind,text){if(!this.e.statusBadge)return;this.e.statusBadge.className=`status ${kind}`;this.e.statusBadge.querySelector('span').textContent=text;}
  startup(text){if(this.e.startupStatus)this.e.startupStatus.textContent=text;} message(text){if(this.e.diagnosticMessage)this.e.diagnosticMessage.textContent=text;}
  check(id,ok,label){if(!this.e[id])return;this.e[id].className=ok?'ok':'pending';this.e[id].innerHTML=`<span>${ok?'✓':'○'}</span> ${label}`;}
  checkResult(id,ok,label,detail=''){if(!this.e[id])return;this.e[id].className=ok?'ok':'failed';this.e[id].innerHTML=`<span>${ok?'✓':'✕'}</span> ${label}${!ok&&detail?` — ${detail}`:''}`;}
  showInitError(module,error){if(!this.e.initErrorCard)return;this.e.initErrorCard.hidden=false;this.e.initErrorModule.textContent=module;this.e.initErrorMessage.textContent=error?.message||String(error);}
  serialLog(message){console.info(`[SERIAL] ${message}`);}
  serialError(error,context=''){console.error(`[SERIAL ERROR]${context?` ${context}`:''}`,error?.name||'Error',error?.message||error);}
  recoveryLog(message){console.info(`[SERIAL RECOVERY] ${message}`);this.log('system',message);}
  recoveryError(step,error){const detail=error?.message||String(error);console.error(`[SERIAL RECOVERY ERROR] ${step}`,error);this.log('error',`${step}: ${detail}`);}
  log(type,message){if(!this.e.terminal)return;const line=document.createElement('div');line.className=`line ${type}`;const time=document.createElement('time');time.textContent=new Date().toLocaleTimeString('es',{hour12:false});const span=document.createElement('span');span.textContent=message;line.append(time,span);this.e.terminal.append(line);while(this.e.terminal.childElementCount>500)this.e.terminal.firstElementChild.remove();if(this.e.autoscroll?.checked)this.e.terminal.scrollTop=this.e.terminal.scrollHeight;}
  toast(message){if(!this.e.toast)return;this.e.toast.textContent=message;this.e.toast.classList.add('show');clearTimeout(this.toastTimer);this.toastTimer=setTimeout(()=>this.e.toast.classList.remove('show'),2600);}
}

let app;
async function initializeApp(){if(app)return app;app=new SerialWorkbench();window.serialWorkbench=app;await app.initialize();return app;}
window.addEventListener('error',event=>{console.error('[Error global]',event.error||event.message);app?.showInitError('JavaScript',event.error||new Error(event.message));});
window.addEventListener('unhandledrejection',event=>{console.error('[Promesa rechazada]',event.reason);app?.showInitError('Operación asíncrona',event.reason instanceof Error?event.reason:new Error(String(event.reason)));});
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',initializeApp,{once:true});else void initializeApp();
export {SerialWorkbench,initializeApp,withTimeout};
