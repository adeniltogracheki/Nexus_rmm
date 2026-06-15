// Mini-cliente RFB para VALIDAR o spike ponta a ponta (sem navegador).
// Conecta como o noVNC faria (WSS /spike/view), faz handshake + auth VNC,
// lê ServerInit (nome + resolução) e confirma recebimento de pixels.
import WebSocket from "ws";

const URL = process.env.PROBE_URL;          // wss://.../spike/view?token=...
const VNC_PW = process.env.PROBE_VNC_PW || "";
if (!URL) { console.error("falta PROBE_URL"); process.exit(1); }

function revBits(b){let r=0;for(let i=0;i<8;i++){r=(r<<1)|((b>>i)&1);}return r&0xff;}
function desResponse(challenge16, pw){
  // VNC auth: chave = senha (8 bytes, cada byte com bits invertidos); DES-ECB nos 2 blocos.
  const key=Buffer.alloc(8,0); const pb=Buffer.from(pw,"latin1"); pb.copy(key,0,0,8);
  for(let i=0;i<8;i++) key[i]=revBits(key[i]);
  // DES-ECB via node crypto
  return import("node:crypto").then(({default:crypto})=>{
    const out=Buffer.alloc(16);
    for(let off=0; off<16; off+=8){
      const c=crypto.createCipheriv("des-ecb",key,null); c.setAutoPadding(false);
      const blk=Buffer.concat([c.update(challenge16.subarray(off,off+8)),c.final()]);
      blk.copy(out,off);
    }
    return out;
  });
}

const ws=new WebSocket(URL);
ws.binaryType="nodebuffer";
let buf=Buffer.alloc(0);
let stage="version";
let bpp=4, fbBytes=0, gotFB=false, w=0,h=0;

const need=(n)=>buf.length>=n;
const take=(n)=>{const b=buf.subarray(0,n);buf=buf.subarray(n);return b;};

ws.on("open",()=>console.log("WS aberto:",URL.split("?")[0]));
ws.on("message", async (data)=>{
  buf=Buffer.concat([buf,data]);
  let progressed=true;
  while(progressed){
    progressed=false;
    if(stage==="version" && need(12)){
      const v=take(12).toString("ascii"); console.log("ServerVersion:",v.trim());
      ws.send(Buffer.from("RFB 003.008\n","ascii")); stage="sec"; progressed=true;
    } else if(stage==="sec" && need(1)){
      const n=buf[0];
      if(n===0){ if(need(1+4)){ take(1); const rl=take(4).readUInt32BE(0); if(need(rl)){console.error("falha sec:",take(rl).toString());ws.close();} } }
      else if(need(1+n)){ take(1); const types=take(n);
        if(![...types].includes(2)){ console.error("sem VNC-auth; tipos:",[...types]); ws.close(); return; }
        ws.send(Buffer.from([2])); stage="challenge"; progressed=true; }
    } else if(stage==="challenge" && need(16)){
      const ch=take(16); const resp=await desResponse(ch,VNC_PW); ws.send(resp); stage="secresult"; progressed=true;
    } else if(stage==="secresult" && need(4)){
      const r=take(4).readUInt32BE(0);
      if(r!==0){ console.error("❌ auth VNC FALHOU (senha?)"); ws.close(); return; }
      console.log("✅ auth VNC OK"); ws.send(Buffer.from([1])); stage="serverinit"; progressed=true; // ClientInit shared=1
    } else if(stage==="serverinit" && need(24)){
      w=buf.readUInt16BE(0); h=buf.readUInt16BE(2); bpp=buf[4]/8;
      const nameLen=buf.readUInt32BE(20);
      if(need(24+nameLen)){
        const head=take(24); const name=take(nameLen).toString("utf8");
        console.log(`✅ ServerInit: ${w}x${h}, ${head[4]} bpp, desktop="${name}"`);
        // pedir 1 frame (Raw)
        const enc=Buffer.alloc(4+4); enc[0]=2; enc.writeUInt16BE(1,2); enc.writeInt32BE(0,4); ws.send(enc); // SetEncodings Raw
        const req=Buffer.alloc(10); req[0]=3; req[1]=0; req.writeUInt16BE(0,2); req.writeUInt16BE(0,4); req.writeUInt16BE(w,6); req.writeUInt16BE(h,8); ws.send(req);
        stage="fb"; progressed=true;
        setTimeout(()=>{
          console.log(gotFB?`✅ pixels recebidos: ${fbBytes} bytes (1º frame ${w}x${h})`:"❌ nenhum pixel recebido");
          console.log(gotFB?"\n🎉 SPIKE VALIDADO: tela ao vivo fim-a-fim (cifrado WSS).":"");
          ws.close(); process.exit(gotFB?0:2);
        }, 4000);
      }
    } else if(stage==="fb"){
      if(buf.length>0){ fbBytes+=buf.length; buf=buf.subarray(buf.length); gotFB=fbBytes>0; }
    }
  }
});
ws.on("error",(e)=>{console.error("erro WS:",e.message);process.exit(1);});
ws.on("close",()=>{ if(stage!=="fb") console.log("fechado no estágio:",stage); });
