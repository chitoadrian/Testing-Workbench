import {splitPages} from './intel-hex.js';
const C={START:0x1b,TOKEN:0x0e,SIGN_ON:0x01,ENTER:0x10,LEAVE:0x11,LOAD:0x06,PROGRAM:0x13,READ:0x14,SIGNATURE:0x1b,OK:0x00};
export function buildStk500v2Frame(sequence,body){const frame=[C.START,sequence,(body.length>>>8)&255,body.length&255,C.TOKEN,...body];frame.push(frame.reduce((a,b)=>a^b,0));return Uint8Array.from(frame);}
export class Stk500v2{
  constructor(transport){this.t=transport;this.sequence=0;}
  async receive(){let start;do{start=await this.t.readByte();}while(start!==C.START);const sequence=await this.t.readByte(),hi=await this.t.readByte(),lo=await this.t.readByte(),token=await this.t.readByte();if(token!==C.TOKEN)throw new Error('Token STK500v2 inválido');const body=await this.t.readExact((hi<<8)|lo),checksum=await this.t.readByte();const bytes=[C.START,sequence,hi,lo,token,...body,checksum];if(bytes.reduce((a,b)=>a^b,0)!==0)throw new Error('Checksum STK500v2 inválido');return{sequence,body};}
  async command(body){const sequence=this.sequence++&255;await this.t.write(buildStk500v2Frame(sequence,body));const response=await this.receive();if(response.sequence!==sequence)throw new Error('Secuencia STK500v2 incorrecta');if(response.body[0]!==body[0]||response.body[1]!==C.OK)throw new Error(`STK500v2 comando 0x${body[0].toString(16)} falló`);return response.body;}
  async sync(){let last;for(let i=0;i<8;i++){try{this.t.flush();const response=await this.command([C.SIGN_ON]);if(response[2]>0)return;}catch(error){last=error;await new Promise(r=>setTimeout(r,80));}}throw last||new Error('Bootloader Mega no encontrado');}
  async enter(){await this.command([C.ENTER,200,100,25,32,0,0x53,3,0xac,0x53,0,0]);}
  async signature(){const result=[];for(let i=0;i<3;i++){const response=await this.command([C.SIGNATURE,0,0,0,i]);result.push(response[2]);}return Uint8Array.from(result);}
  async loadAddress(byteAddress){const word=byteAddress>>>1;await this.command([C.LOAD,(word>>>24)&255,(word>>>16)&255,(word>>>8)&255,word&255]);}
  async programPage(address,data){await this.loadAddress(address);await this.command([C.PROGRAM,data.length>>>8,data.length&255,0xc1,10,0x40,0x4c,0x20,0,0,...data]);}
  async readPage(address,length){await this.loadAddress(address);const response=await this.command([C.READ,length>>>8,length&255,0x20,0]);if(response.length<length+3)throw new Error('Respuesta de lectura STK500v2 incompleta');return response.slice(2,2+length);}
  async leave(){await this.command([C.LEAVE,1,1]);}
  async flash(data,onProgress=()=>{}){await this.sync();await this.enter();const signature=await this.signature();if([...signature].join(',')!=='30,152,1')throw new Error(`Firma inesperada para ATmega2560: ${[...signature].map(x=>x.toString(16).padStart(2,'0')).join(' ')}`);const pages=splitPages(data,256);for(let i=0;i<pages.length;i++){await this.programPage(pages[i].address,pages[i].data);onProgress({phase:'write',completed:i+1,total:pages.length,address:pages[i].address});}for(let i=0;i<pages.length;i++){const actual=await this.readPage(pages[i].address,pages[i].data.length);for(let j=0;j<actual.length;j++)if(actual[j]!==pages[i].data[j])throw new Error(`Verificación falló en 0x${(pages[i].address+j).toString(16)}`);onProgress({phase:'verify',completed:i+1,total:pages.length,address:pages[i].address});}await this.leave();return signature;}
}
export {C as STK500V2};
