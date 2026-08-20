import {parseIntelHex} from './intel-hex.js';
import {AvrSerialTransport} from './avr-transport.js';
import {Stk500v1} from './stk500v1.js';
import {Stk500v2} from './stk500v2.js';

export const BOARD_PROFILES={
  uno:{label:'Arduino Uno',baud:115200,pageSize:128,maximumSize:32256,hex:'firmware/uno/testing-workbench.hex',Protocol:Stk500v1},
  mega:{label:'Arduino Mega 2560',baud:115200,pageSize:256,maximumSize:253952,hex:'firmware/mega/testing-workbench.hex',Protocol:Stk500v2}
};

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

export class FirmwareManager{
  constructor(app){this.app=app;this.busy=false;this.e={panel:document.querySelector('.firmware-panel'),board:document.getElementById('firmwareBoard'),port:document.getElementById('firmwarePort'),version:document.getElementById('firmwareVersion'),status:document.getElementById('firmwareStatus'),detail:document.getElementById('firmwareDetail'),progress:document.getElementById('firmwareProgress'),install:document.getElementById('installFirmwareBtn')};}
  init(){this.e.install.addEventListener('click',()=>this.install());this.e.board.addEventListener('change',()=>this.setState('Firmware no detectado','Confirme la placa antes de instalar.',0));this.refreshPort();}
  refreshPort(){const port=this.app.port||this.app.authorizedPorts[0],available=Boolean(port);let label='No seleccionado';if(port){try{const info=port.getInfo?.()||{};const vid=info.usbVendorId?.toString(16).padStart(4,'0'),pid=info.usbProductId?.toString(16).padStart(4,'0');label=vid&&pid?`USB ${vid}:${pid}`:'Puerto Serial autorizado';const megaPids=[0x0010,0x0042,0x0210,0x0242];if(info.usbVendorId===0x2341&&megaPids.includes(info.usbProductId))this.e.board.value='mega';}catch{label='Puerto Serial autorizado';}}this.e.port.textContent=label;this.e.install.disabled=!available||this.busy;}
  setState(status,detail,percent){this.e.status.textContent=status;this.e.detail.textContent=detail;this.e.progress.style.width=`${Math.max(0,Math.min(100,percent))}%`;}
  setFirmwareInfo(info){if(info?.firmware==='HW-WORKBENCH'){this.e.version.textContent=`${info.firmware} v${info.version}`;this.e.install.textContent='Actualizar firmware';this.setState('Firmware compatible','Arduino operativo.',100);}else if(info){this.e.version.textContent=info.version||'Desconocida';this.e.install.textContent='Instalar firmware en Arduino';this.setState('Firmware desactualizado','Instale la versión compatible HW-WORKBENCH.',0);}else{this.e.version.textContent='—';this.e.install.textContent='Instalar firmware en Arduino';this.setState('Firmware no detectado','No se detectó el firmware del Testing Workbench.',0);}this.refreshPort();}
  progress(update){const base=update.phase==='write'?15:85,span=update.phase==='write'?70:13;const percent=base+span*update.completed/update.total;const action=update.phase==='write'?'Cargando firmware':'Verificando';this.setState(`${action}...`,`${action}: página ${update.completed}/${update.total} · 0x${update.address.toString(16)}`,percent);}
  async resetBootloader(port){if(typeof port.setSignals==='function'){try{await port.setSignals({dataTerminalReady:false,requestToSend:false});await sleep(60);await port.setSignals({dataTerminalReady:true,requestToSend:false});await sleep(80);await port.setSignals({dataTerminalReady:false,requestToSend:false});}catch(error){console.warn('[FIRMWARE] setSignals no disponible; se usa el reset producido por port.open()',error);}}await sleep(120);}
  async install(){
    if(this.busy)return;const key=this.e.board.value,profile=BOARD_PROFILES[key],port=this.app.port||this.app.authorizedPorts[0];if(!port)return this.setState('Error de carga','Seleccione primero un puerto Serial.',0);
    this.busy=true;this.app.connectionInProgress=true;this.e.panel.classList.add('flashing');this.e.install.disabled=true;let transport;
    try{
      this.setState('Preparando carga...','Cerrando modo Workbench.',2);await this.app.cleanupSerialConnection('firmware-upload',{keepUI:true});
      const response=await fetch(profile.hex,{cache:'no-store'});if(!response.ok)throw new Error(`No se encontró firmware local (${response.status})`);const image=parseIntelHex(await response.text(),profile.maximumSize);
      this.setState('Entrando al bootloader...',`${profile.label} · ${profile.baud} baud`,7);transport=new AvrSerialTransport(port,1600);await transport.open(profile.baud);await this.resetBootloader(port);
      this.setState('Sincronizando bootloader...','Esperando respuesta AVR.',10);const protocol=new profile.Protocol(transport);await protocol.flash(image,update=>this.progress(update));
      this.setState('Carga completada','Flash escrita y verificada.',100);await transport.close();transport=null;
      this.setState('Reiniciando Arduino...','Cambiando a modo Workbench.',100);await sleep(1200);this.app.port=port;await this.app.openPort();
      if(!this.app.hardwareReady)throw new Error('Firmware cargado, pero no respondió PING/GET:INFO tras reiniciar');
      this.setState('Arduino operativo','Firmware instalado y verificado por GET:INFO.',100);
    }catch(error){console.error('[FIRMWARE ERROR]',error);this.setState('Error de carga',this.explain(error),0);try{await transport?.close();}catch{}await this.app.cleanupSerialConnection('firmware-error',{keepUI:true});}
    finally{this.busy=false;this.app.connectionInProgress=false;this.e.panel.classList.remove('flashing');this.refreshPort();this.app.setConnectionControlsBusy(false);}
  }
  explain(error){if(error.name==='TimeoutError')return'Bootloader sin respuesta. Verifique placa seleccionada y vuelva a intentar.';if(/Firma inesperada/.test(error.message))return`${error.message}. Seleccione la placa correcta.`;if(/Verificación falló/.test(error.message))return error.message;return error.message||'Fallo desconocido durante la carga.';}
}
