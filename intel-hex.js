export function parseIntelHex(text, maximumSize=Infinity){
  const memory=new Map();let upper=0,eof=false;
  for(const [index,source] of text.split(/\r?\n/).entries()){
    const line=source.trim();if(!line)continue;
    if(line[0]!==':'||line.length<11)throw new Error(`HEX inválido en línea ${index+1}`);
    const bytes=[];for(let i=1;i<line.length;i+=2)bytes.push(Number.parseInt(line.slice(i,i+2),16));
    if(bytes.some(Number.isNaN))throw new Error(`HEX no hexadecimal en línea ${index+1}`);
    if((bytes.reduce((a,b)=>a+b,0)&255)!==0)throw new Error(`Checksum HEX inválido en línea ${index+1}`);
    const count=bytes[0],address=(bytes[1]<<8)|bytes[2],type=bytes[3];
    if(bytes.length!==count+5)throw new Error(`Longitud HEX inválida en línea ${index+1}`);
    if(type===0){for(let i=0;i<count;i++){const absolute=upper+address+i;if(absolute>=maximumSize)throw new Error('Firmware excede la memoria flash de la placa');memory.set(absolute,bytes[4+i]);}}
    else if(type===1){eof=true;break;}
    else if(type===2)upper=((bytes[4]<<8)|bytes[5])<<4;
    else if(type===4)upper=((bytes[4]<<8)|bytes[5])<<16;
  }
  if(!eof)throw new Error('HEX sin registro EOF');
  let highest=-1;for(const address of memory.keys())if(address>highest)highest=address;const length=highest+1;
  const data=new Uint8Array(length).fill(255);for(const [address,value] of memory)data[address]=value;
  return data;
}

export function splitPages(data,pageSize){
  const pages=[];for(let address=0;address<data.length;address+=pageSize)pages.push({address,data:data.slice(address,Math.min(address+pageSize,data.length))});
  return pages;
}
