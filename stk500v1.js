import {splitPages} from './intel-hex.js';
const C={SYNC:0x30,ENTER:0x50,LEAVE:0x51,LOAD:0x55,PROG:0x64,READ:0x74,SIGN:0x75,EOP:0x20,INSYNC:0x14,OK:0x10};
export class Stk500v1{
  constructor(transport){this.t=transport;}
  async command(bytes,responseLength=0){await this.t.write([...bytes,C.EOP]);const sync=await this.t.readByte();if(sync!==C.INSYNC)throw new Error(`STK500v1 fuera de sincronía: 0x${sync.toString(16)}`);const data=responseLength?await this.t.readExact(responseLength):new Uint8Array();const status=await this.t.readByte();if(status!==C.OK)throw new Error(`STK500v1 status 0x${status.toString(16)}`);return data;}
  async sync(){let last;for(let i=0;i<8;i++){try{this.t.flush();await this.command([C.SYNC]);return;}catch(error){last=error;await new Promise(r=>setTimeout(r,80));}}throw last||new Error('Bootloader Uno no encontrado');}
  async signature(){return this.command([C.SIGN],3);}
  async enter(){await this.command([C.ENTER]);}
  async loadAddress(byteAddress){const word=byteAddress>>>1;await this.command([C.LOAD,word&255,(word>>>8)&255]);}
  async programPage(address,data){await this.loadAddress(address);await this.command([C.PROG,data.length>>>8,data.length&255,0x46,...data]);}
  async readPage(address,length){await this.loadAddress(address);return this.command([C.READ,length>>>8,length&255,0x46],length);}
  async leave(){await this.command([C.LEAVE]);}
  async flash(data,onProgress=()=>{}){await this.sync();const signature=await this.signature();if([...signature].join(',')!=='30,149,15')throw new Error(`Firma inesperada para ATmega328P: ${[...signature].map(x=>x.toString(16).padStart(2,'0')).join(' ')}`);await this.enter();const pages=splitPages(data,128);for(let i=0;i<pages.length;i++){await this.programPage(pages[i].address,pages[i].data);onProgress({phase:'write',completed:i+1,total:pages.length,address:pages[i].address});}for(let i=0;i<pages.length;i++){const actual=await this.readPage(pages[i].address,pages[i].data.length);for(let j=0;j<actual.length;j++)if(actual[j]!==pages[i].data[j])throw new Error(`Verificación falló en 0x${(pages[i].address+j).toString(16)}`);onProgress({phase:'verify',completed:i+1,total:pages.length,address:pages[i].address});}await this.leave();return signature;}
}
export {C as STK500V1};
