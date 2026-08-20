export class AvrSerialTransport{
  constructor(port,timeoutMs=1500){this.port=port;this.timeoutMs=timeoutMs;this.reader=null;this.writer=null;this.queue=[];this.waiters=[];this.running=false;}
  async open(baudRate){await this.port.open({baudRate,bufferSize:4096});this.reader=this.port.readable.getReader();this.writer=this.port.writable.getWriter();this.running=true;void this.readLoop();}
  async readLoop(){try{while(this.running){const {value,done}=await this.reader.read();if(done)break;for(const byte of value)this.push(byte);}}catch(error){if(this.running)this.fail(error);}}
  push(byte){const waiter=this.waiters.shift();if(waiter)waiter.resolve(byte);else this.queue.push(byte);}
  fail(error){this.running=false;for(const waiter of this.waiters.splice(0))waiter.reject(error);}
  async write(bytes){if(!this.writer)throw new Error('Writer de bootloader no disponible');await this.writer.write(Uint8Array.from(bytes));}
  readByte(timeoutMs=this.timeoutMs){if(this.queue.length)return Promise.resolve(this.queue.shift());return new Promise((resolve,reject)=>{const waiter={resolve:value=>{clearTimeout(timer);resolve(value);},reject:error=>{clearTimeout(timer);reject(error);}};const timer=setTimeout(()=>{const i=this.waiters.indexOf(waiter);if(i>=0)this.waiters.splice(i,1);reject(new DOMException('Bootloader sin respuesta','TimeoutError'));},timeoutMs);this.waiters.push(waiter);});}
  async readExact(length,timeoutMs=this.timeoutMs){const result=new Uint8Array(length);for(let i=0;i<length;i++)result[i]=await this.readByte(timeoutMs);return result;}
  flush(){this.queue.length=0;}
  async close(){this.running=false;try{await this.reader?.cancel();}catch{}try{this.reader?.releaseLock();}catch{}this.reader=null;try{await this.writer?.close();}catch{}try{this.writer?.releaseLock();}catch{}this.writer=null;try{if(this.port?.readable||this.port?.writable)await this.port.close();}catch{}this.fail(new DOMException('Transporte cerrado','AbortError'));}
}
