import assert from 'node:assert/strict';
import fs from 'node:fs';

const html=fs.readFileSync(new URL('./index.html',import.meta.url),'utf8');
const source=fs.readFileSync(new URL('./app.js',import.meta.url),'utf8');
const requiredIds=['connectBtn','searchDeviceBtn','reconnectBtn','testPingBtn','resetSerialBtn','retryDiagnosticsBtn','commandForm','clearBtn','pauseBtn','resetMetrics','stressBtn','installFirmwareBtn','firmwareBoard','checkUiControls','checkFirmwareResources','environmentInfo'];
for(const id of requiredIds)assert.match(html,new RegExp(`id=["']${id}["']`),`Falta #${id}`);
assert.match(html,/window\.__HW_BUILD_VERSION__\s*=\s*'2026\.08\.20\.1'/);
assert.match(html,/app\.js\?v=/);
assert.match(html,/El módulo principal de JavaScript no pudo iniciar/);

const elements=new Map();
function element(id){if(!elements.has(id))elements.set(id,{id,disabled:false,hidden:false,value:id==='baudRate'?'115200':'',textContent:'',className:'',dataset:{},style:{setProperty(){}},classList:{add(){},remove(){},toggle(){}},listeners:{},addEventListener(type,handler){(this.listeners[type]??=[]).push(handler);},setAttribute(){},querySelector(){return element(`${id}-child`);},append(){},replaceChildren(){}});return elements.get(id);}
const tabs=['actuators','sensors','motors'].map(name=>{const e=element(`tab-${name}`);e.dataset.tab=name;return e;});
const hardware=[{disabled:false,title:'',setAttribute(){}}];
globalThis.document={readyState:'loading',hidden:false,getElementById:element,addEventListener(){},createElement:element,querySelector(){return element('firmware-panel');},querySelectorAll(selector){if(selector==='.tab')return tabs;if(selector==='[data-command]')return[];if(selector==='[data-hardware-control]')return hardware;if(selector==='.tab-panel')return[];return[];}};
globalThis.window={__HW_BUILD_VERSION__:'2026.08.20.1',isSecureContext:true,self:{},top:{},addEventListener(){}};window.top=window.self;
globalThis.location={protocol:'https:'};
Object.defineProperty(globalThis,'navigator',{configurable:true,value:{userAgent:'Mozilla/5.0 Windows Chrome/140.0',serial:{addEventListener(){},getPorts:async()=>[]}}});
globalThis.localStorage={getItem(){return null;},setItem(){}};
globalThis.fetch=async()=>({ok:true,status:200});

const {SerialWorkbench}=await import('./app.js');
const app=new SerialWorkbench();
app.initUI();app.initDiagnostics();app.initGallery();app.initMonitor();app.initMetrics();app.initStress();
app.registeredListeners.add('installFirmwareBtn:click');app.registeredListeners.add('firmwareBoard:change');
assert.deepEqual(app.auditUiControls(),{ok:true,failures:[]});

// Volver a inicializar un módulo no duplica listeners registrados con on().
app.initMonitor();
assert.equal(element('clearBtn').listeners.click.length,1);
assert.equal(element('commandForm').listeners.submit.length,1);

// Sliders y tabs son controles visuales y sus listeners funcionan sin Arduino.
element('pwmSlider').value='77';element('pwmSlider').listeners.input[0]({target:element('pwmSlider')});
assert.equal(element('pwmValue').textContent,'77');
tabs[1].listeners.click[0]();
assert.equal(app.hardwareReady,false);

app.setHardwareReady(false);assert.equal(hardware[0].disabled,true);
app.setHardwareReady(true);assert.equal(hardware[0].disabled,false);

async function errorMessage(name,message='fallo'){
  const test=new SerialWorkbench();let shown='';test.cleanupSerialConnection=async()=>{};test.message=text=>{shown=text;};test.log=()=>{};test.connectionState=()=>{};test.renderMetrics=()=>{};await test.connectionError(new DOMException(message,name));return shown;
}
assert.match(await errorMessage('SecurityError'),/política del equipo/);
assert.match(await errorMessage('NotFoundError'),/Selección cancelada/);
assert.match(await errorMessage('NetworkError'),/ocupado/);

delete navigator.serial;
const noSerial=new SerialWorkbench();noSerial.checkFirmwareResources=async()=>({ok:true,failures:[]});await noSerial.runDiagnostics();
assert.match(element('diagnosticMessage').textContent,/Chrome o Edge/);
assert.match(source,/\[INIT ERROR\]/);
console.log('ui-smoke: DOM, listeners, tabs, sliders, hardwareReady, errores, aislamiento y Web Serial ausente OK');
