import assert from 'node:assert/strict';
import fs from 'node:fs';
import {parseIntelHex,splitPages} from './intel-hex.js';
import {Stk500v1,STK500V1} from './stk500v1.js';
import {buildStk500v2Frame,Stk500v2,STK500V2} from './stk500v2.js';
import {AvrSerialTransport} from './avr-transport.js';

for(const [board,max,page] of [['uno',32256,128],['mega',253952,256]]){
  const text=fs.readFileSync(new URL(`./firmware/${board}/testing-workbench.hex`,import.meta.url),'utf8');
  const image=parseIntelHex(text,max);assert.ok(image.length>14000);assert.ok(splitPages(image,page).length>1);
}
assert.throws(()=>parseIntelHex(':0100000000FE\n:00000001FF'),/Checksum/);
assert.deepEqual([...splitPages(Uint8Array.from([1,2,3,4,5]),2)].map(x=>x.data.length),[2,2,1]);

class V1Transport{constructor(){this.queue=[];this.last=[];}async write(bytes){this.last=[...bytes];const command=bytes[0];this.queue.push(STK500V1.INSYNC,...(command===STK500V1.SIGN?[0x1e,0x95,0x0f]:[]),STK500V1.OK);}async readByte(){return this.queue.shift();}async readExact(n){return Uint8Array.from(this.queue.splice(0,n));}flush(){}}
const v1t=new V1Transport(),v1=new Stk500v1(v1t);await v1.sync();assert.equal(v1t.last.at(-1),STK500V1.EOP);assert.deepEqual([...await v1.signature()],[0x1e,0x95,0x0f]);

const body=[STK500V2.SIGN_ON],frame=buildStk500v2Frame(7,body);assert.equal(frame.reduce((a,b)=>a^b,0),0);assert.equal(frame[0],STK500V2.START);assert.equal(frame[4],STK500V2.TOKEN);
class V2Transport{constructor(){this.queue=[];}async write(frame){const sequence=frame[1],command=frame[5],response=buildStk500v2Frame(sequence,[command,0,8,65,86,82,73,83,80,95,50]);this.queue.push(...response);}async readByte(){return this.queue.shift();}async readExact(n){return Uint8Array.from(this.queue.splice(0,n));}flush(){}}
const v2=new Stk500v2(new V2Transport());await v2.sync();

const timeoutPort={};const timeoutTransport=new AvrSerialTransport(timeoutPort,5);await assert.rejects(timeoutTransport.readByte(),error=>error.name==='TimeoutError');

class WrongSignature extends V1Transport{async write(bytes){this.last=[...bytes];this.queue.push(STK500V1.INSYNC,...(bytes[0]===STK500V1.SIGN?[0,0,0]:[]),STK500V1.OK);}}
await assert.rejects(new Stk500v1(new WrongSignature()).flash(Uint8Array.from([1,2])),/Firma inesperada/);

class BadVerify extends V1Transport{async write(bytes){this.last=[...bytes];const command=bytes[0],length=command===STK500V1.READ?(bytes[1]<<8)|bytes[2]:0;this.queue.push(STK500V1.INSYNC,...(command===STK500V1.SIGN?[0x1e,0x95,0x0f]:new Array(length).fill(0)),STK500V1.OK);}}
const progress=[];await assert.rejects(new Stk500v1(new BadVerify()).flash(Uint8Array.from([1,2,3]),update=>progress.push(update)),/Verificación falló/);assert.equal(progress[0].phase,'write');assert.equal(progress[0].completed,1);

const disconnected=new AvrSerialTransport({},100);const pending=disconnected.readByte();disconnected.fail(new DOMException('USB desconectado','NetworkError'));await assert.rejects(pending,error=>error.name==='NetworkError');

console.log('firmware-flasher: parser, páginas, checksums, STK500v1/v2, progreso, timeout, desconexión, placa y verificación OK');
