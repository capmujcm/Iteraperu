'use strict';
/* =============================================================================
   Country Fest - nucleo compartido de la app real
   =============================================================================
   Lo usan asistente.html y staff.html. Contiene:

     1. Codificador y decodificador de QR (motor propio, sin dependencias)
     2. Camara con lectura de QR
     3. Navegacion entre pantallas
     4. Cliente de la API: sesion de la persona y token de staff
     5. Helpers de escape para HTML

   Sobre el escape: en este proyecto NADA que venga del servidor o de un
   formulario entra en innerHTML sin pasar por esc(). Los nombres de personas
   van siempre por NM(). Es la regla del CLAUDE.md y aqui no hay excepciones.
   ========================================================================== */

/* ===================================================================
   Motor QR propio — versiones 1-5, EC nivel L. Verificado con
   decodificador independiente (ver qr-test.html).
   =================================================================== */
const QR=(function(){
  const EXP=new Array(512),LOG=new Array(256);
  (function(){let x=1;for(let i=0;i<255;i++){EXP[i]=x;LOG[x]=i;x<<=1;if(x&0x100)x^=0x11D;}for(let i=255;i<512;i++)EXP[i]=EXP[i-255];})();
  function gmul(a,b){if(a===0||b===0)return 0;return EXP[LOG[a]+LOG[b]];}
  function rsGen(n){let p=[1];for(let i=0;i<n;i++){const r=EXP[i];const nx=new Array(p.length+1).fill(0);nx[0]=p[0];
    for(let k=1;k<p.length;k++)nx[k]=p[k]^gmul(r,p[k-1]);nx[p.length]=gmul(r,p[p.length-1]);p=nx;}return p;}
  function rsEnc(d,ec){const g=rsGen(ec);const b=d.concat(new Array(ec).fill(0));
    for(let i=0;i<d.length;i++){const c=b[i];if(c===0)continue;for(let j=0;j<g.length;j++)b[i+j]^=gmul(g[j],c);}return b.slice(d.length);}
  const V={1:{total:26,ec:7,size:21},2:{total:44,ec:10,size:25},3:{total:70,ec:15,size:29},4:{total:100,ec:20,size:33},5:{total:134,ec:26,size:37}};
  const AL={2:[6,18],3:[6,22],4:[6,26],5:[6,30]};
  const MAXB=V[5].total-V[5].ec-2;
  function bestV(n){if(n>MAXB)throw new Error('payload muy largo');for(const v of[1,2,3,4,5]){if(n<=(V[v].total-V[v].ec)-2)return v;}return 5;}
  function bits(bytes,cap){let s='0100'+bytes.length.toString(2).padStart(8,'0');for(const b of bytes)s+=b.toString(2).padStart(8,'0');
    const tot=cap*8;s+='0'.repeat(Math.max(0,Math.min(4,tot-s.length)));while(s.length%8!==0)s+='0';
    const pad=['11101100','00010001'];let i=0;while(s.length<tot){s+=pad[i%2];i++;}
    const cw=[];for(let k=0;k<s.length;k+=8)cw.push(parseInt(s.slice(k,k+8),2));return cw;}
  function fmtBits(ec,mask){let d=(ec<<3)|mask;let g=d<<10;for(let i=14;i>=10;i--){if(g&(1<<i))g^=(0x537<<(i-10));}
    return (((d<<10)|g)^0x5412).toString(2).padStart(15,'0').split('').map(c=>c==='1');}
  function build(ver,dcw,ecLevel){
    const size=V[ver].size;
    const m=Array.from({length:size},()=>new Array(size).fill(null));
    const res=Array.from({length:size},()=>new Array(size).fill(false));
    const put=(r,c,v)=>{if(r>=0&&r<size&&c>=0&&c<size){m[r][c]=v;res[r][c]=true;}};
    const rsv=(r,c)=>{if(r>=0&&r<size&&c>=0&&c<size)res[r][c]=true;};
    function finder(r0,c0){for(let r=-1;r<=7;r++)for(let c=-1;c<=7;c++){const rr=r0+r,cc=c0+c;
      if(rr<0||cc<0||rr>=size||cc>=size)continue;let on=false;
      if(r>=0&&r<=6&&c>=0&&c<=6)on=(r===0||r===6||c===0||c===6||(r>=2&&r<=4&&c>=2&&c<=4));put(rr,cc,on);}}
    finder(0,0);finder(0,size-7);finder(size-7,0);
    const al=AL[ver];
    if(al){const co=[];for(const a of al)for(const b of al)co.push([a,b]);
      const z=[[-1,7,-1,7],[-1,7,size-8,size],[size-8,size,-1,7]];
      const ov=(r0,c0)=>{const r1=r0-2,r2=r0+2,c1=c0-2,c2=c0+2;return z.some(([a,b,c,d])=>r1<=b&&r2>=a&&c1<=d&&c2>=c);};
      for(const[r0,c0]of co){if(ov(r0,c0))continue;
        for(let r=-2;r<=2;r++)for(let c=-2;c<=2;c++)put(r0+r,c0+c,Math.max(Math.abs(r),Math.abs(c))!==1);}}
    for(let i=8;i<size-8;i++){if(m[6][i]===null)put(6,i,i%2===0);if(m[i][6]===null)put(i,6,i%2===0);}
    put(size-8,8,true);
    for(let i=0;i<9;i++){rsv(8,i);rsv(i,8);}
    for(let i=0;i<8;i++){rsv(8,size-1-i);rsv(size-1-i,8);}
    const bs=[];for(const cw of dcw)for(let b=7;b>=0;b--)bs.push((cw>>b)&1);
    let bi=0,dir=-1,col=size-1;
    while(col>0){if(col===6)col--;
      for(let i=0;i<size;i++){const row=dir===-1?size-1-i:i;
        for(const c of[col,col-1]){if(res[row][c])continue;const b=bi<bs.length?bs[bi]:0;bi++;m[row][c]=!!b;}}
      dir=-dir;col-=2;}
    for(let r=0;r<size;r++)for(let c=0;c<size;c++){if(!res[r][c]&&((r+c)%2===0))m[r][c]=!m[r][c];}
    const fb=fmtBits(ecLevel,0);
    const fA=[[8,0],[8,1],[8,2],[8,3],[8,4],[8,5],[8,7],[8,8],[7,8],[5,8],[4,8],[3,8],[2,8],[1,8],[0,8]];
    for(let i=0;i<15;i++){const[r,c]=fA[i];m[r][c]=fb[i];}
    const fB=[[size-1,8],[size-2,8],[size-3,8],[size-4,8],[size-5,8],[size-6,8],[size-7,8],
              [8,size-8],[8,size-7],[8,size-6],[8,size-5],[8,size-4],[8,size-3],[8,size-2],[8,size-1]];
    for(let i=0;i<15;i++){const[r,c]=fB[i];m[r][c]=fb[i];}
    put(size-8,8,true);
    return m;
  }
  function encode(text){
    const by=Array.from(new TextEncoder().encode(text));
    const ver=bestV(by.length),inf=V[ver],cap=inf.total-inf.ec;
    const d=bits(by,cap),ec=rsEnc(d,inf.ec);
    return {matrix:build(ver,d.concat(ec),1),size:inf.size};
  }
  return {encode};
})();
function drawQR(text,canvas,scale){
  if(!canvas)return;
  try{
    const {matrix,size}=QR.encode(text);const q=4;
    canvas.width=(size+q*2)*scale;canvas.height=(size+q*2)*scale;
    const x=canvas.getContext('2d');
    x.fillStyle='#fff';x.fillRect(0,0,canvas.width,canvas.height);x.fillStyle='#111';
    for(let r=0;r<size;r++)for(let c=0;c<size;c++)if(matrix[r][c])x.fillRect((c+q)*scale,(r+q)*scale,scale,scale);
  }catch(e){console.warn('QR',e);}
}

/* ===================================================================
   Decodificador QR propio — contraparte del codificador de arriba.
   Hace falta porque NINGÚN navegador de iPhone implementa
   BarcodeDetector: Safari, Chrome y Firefox en iOS corren todos sobre
   WebKit, y WebKit no lo soporta. Sin esto la cámara nunca funciona
   en iPhone, que es la mitad del público de un evento.

   Cubre v1-5, EC-L, modo byte y bloque único: exactamente lo que
   genera el codificador de este prototipo.

   No corrige errores a propósito: valida el frame por síndromes
   Reed-Solomon y, si no da limpio, lo descarta y prueba el siguiente.
   A 10 fps eso es más seguro que arriesgar una lectura equivocada.
   =================================================================== */
const QRDEC=(function(){
  const EXP=new Array(512),LOG=new Array(256);
  (function(){let x=1;for(let i=0;i<255;i++){EXP[i]=x;LOG[x]=i;x<<=1;if(x&0x100)x^=0x11D;}for(let i=255;i<512;i++)EXP[i]=EXP[i-255];})();
  const gmul=(a,b)=>(a===0||b===0)?0:EXP[LOG[a]+LOG[b]];
  const V={1:{total:26,ec:7},2:{total:44,ec:10},3:{total:70,ec:15},4:{total:100,ec:20},5:{total:134,ec:26}};
  const AL={2:[6,18],3:[6,22],4:[6,26],5:[6,30]};
  const S2V={21:1,25:2,29:3,33:4,37:5};
  const MASKS=[(r,c)=>(r+c)%2===0,(r,c)=>r%2===0,(r,c)=>c%3===0,(r,c)=>(r+c)%3===0,
    (r,c)=>(((r/2)|0)+((c/3)|0))%2===0,(r,c)=>((r*c)%2)+((r*c)%3)===0,
    (r,c)=>((((r*c)%2)+((r*c)%3))%2)===0,(r,c)=>((((r+c)%2)+((r*c)%3))%2)===0];
  function fmtVal(ec,mask){let d=(ec<<3)|mask,g=d<<10;
    for(let i=14;i>=10;i--)if(g&(1<<i))g^=(0x537<<(i-10));
    return ((d<<10)|g)^0x5412;}

  /* mapa de patrones de función — refleja exactamente al codificador */
  function funcMap(size,ver){
    const res=Array.from({length:size},()=>new Array(size).fill(false));
    const rsv=(r,c)=>{if(r>=0&&r<size&&c>=0&&c<size)res[r][c]=true;};
    for(const[r0,c0]of[[0,0],[0,size-7],[size-7,0]])
      for(let r=-1;r<=7;r++)for(let c=-1;c<=7;c++)rsv(r0+r,c0+c);
    const al=AL[ver];
    if(al){const co=[];for(const a of al)for(const b of al)co.push([a,b]);
      const z=[[-1,7,-1,7],[-1,7,size-8,size],[size-8,size,-1,7]];
      const ov=(r0,c0)=>{const r1=r0-2,r2=r0+2,c1=c0-2,c2=c0+2;return z.some(([a,b,c,d])=>r1<=b&&r2>=a&&c1<=d&&c2>=c);};
      for(const[r0,c0]of co){if(ov(r0,c0))continue;
        for(let r=-2;r<=2;r++)for(let c=-2;c<=2;c++)rsv(r0+r,c0+c);}}
    for(let i=8;i<size-8;i++){rsv(6,i);rsv(i,6);}
    rsv(size-8,8);
    for(let i=0;i<9;i++){rsv(8,i);rsv(i,8);}
    for(let i=0;i<8;i++){rsv(8,size-1-i);rsv(size-1-i,8);}
    return res;
  }

  /* síndromes RS: 0 en todos = el frame se leyó perfecto */
  function rsOk(cw,ecLen){
    for(let i=0;i<ecLen;i++){
      let s=0;const a=EXP[i];
      for(let j=0;j<cw.length;j++)s=gmul(s,a)^cw[j];
      if(s!==0)return false;
    }
    return true;
  }

  /* matriz booleana (true = módulo oscuro) -> texto */
  function decodeMatrix(m){
    const size=m.length, ver=S2V[size];
    if(!ver)return null;
    const FA=[[8,0],[8,1],[8,2],[8,3],[8,4],[8,5],[8,7],[8,8],[7,8],[5,8],[4,8],[3,8],[2,8],[1,8],[0,8]];
    let raw=0;
    for(let i=0;i<15;i++){const[r,c]=FA[i];raw=(raw<<1)|(m[r][c]?1:0);}
    let ecL=-1,mask=-1;
    for(let e=0;e<4&&mask<0;e++)for(let k=0;k<8;k++)if(fmtVal(e,k)===raw){ecL=e;mask=k;break;}
    if(mask<0)return null;

    const res=funcMap(size,ver), mk=MASKS[mask];
    const bits=[];
    let dir=-1,col=size-1;
    while(col>0){
      if(col===6)col--;
      for(let i=0;i<size;i++){
        const row=dir===-1?size-1-i:i;
        for(const c of[col,col-1]){
          if(res[row][c])continue;
          bits.push((m[row][c]!==mk(row,c))?1:0);
        }
      }
      dir=-dir;col-=2;
    }
    const inf=V[ver], cw=[];
    for(let i=0;i+7<bits.length&&cw.length<inf.total;i+=8){
      let b=0;for(let k=0;k<8;k++)b=(b<<1)|bits[i+k];cw.push(b);
    }
    if(cw.length<inf.total||!rsOk(cw,inf.ec))return null;

    const data=cw.slice(0,inf.total-inf.ec);
    let bp=0;
    const take=n=>{let v=0;for(let i=0;i<n;i++){const byte=data[(bp/8)|0];if(byte===undefined)return -1;
      v=(v<<1)|((byte>>(7-(bp%8)))&1);bp++;}return v;};
    if(take(4)!==4)return null;              // solo modo byte
    const len=take(8);
    if(len<0||len>data.length)return null;
    const out=[];
    for(let i=0;i<len;i++){const b=take(8);if(b<0)return null;out.push(b);}
    try{ return new TextDecoder().decode(new Uint8Array(out)); }catch(e){ return null; }
  }

  /* ---------- localización de patrones de búsqueda (1:1:3:1:1) ---------- */
  function otsu(gray){
    const h=new Array(256).fill(0);
    for(let i=0;i<gray.length;i++)h[gray[i]]++;
    const tot=gray.length;
    let sum=0;for(let i=0;i<256;i++)sum+=i*h[i];
    let sumB=0,wB=0,best=0,thr=128;
    for(let t=0;t<256;t++){
      wB+=h[t];if(!wB)continue;
      const wF=tot-wB;if(!wF)break;
      sumB+=t*h[t];
      const mB=sumB/wB,mF=(sum-sumB)/wF,v=wB*wF*(mB-mF)*(mB-mF);
      if(v>best){best=v;thr=t;}
    }
    return thr;
  }
  const ratioOk=r=>{
    const u=(r[0]+r[1]+r[3]+r[4])/4;           // módulo estimado
    if(u<1)return false;
    const tol=u*0.6;
    return Math.abs(r[0]-u)<tol&&Math.abs(r[1]-u)<tol&&
           Math.abs(r[3]-u)<tol&&Math.abs(r[4]-u)<tol&&
           Math.abs(r[2]-3*u)<tol*2.2;
  };
  function crossVertical(bin,w,h,cx,cy){
    const at=(x,y)=>(x<0||y<0||x>=w||y>=h)?0:bin[y*w+x];
    if(!at(cx,cy))return null;
    const r=[0,0,0,0,0];
    let y=cy;while(y>=0&&at(cx,y)){r[2]++;y--;}
    while(y>=0&&!at(cx,y)){r[1]++;y--;}
    while(y>=0&&at(cx,y)){r[0]++;y--;}
    y=cy+1;while(y<h&&at(cx,y)){r[2]++;y++;}
    while(y<h&&!at(cx,y)){r[3]++;y++;}
    while(y<h&&at(cx,y)){r[4]++;y++;}
    if(!r[0]||!r[1]||!r[3]||!r[4]||!ratioOk(r))return null;
    // 5 anchos de módulo en total: 1+1+3+1+1, con el central contando por 3
    return {y:y-r[4]-r[3]-r[2]/2, mod:(r[0]+r[1]+r[2]/3+r[3]+r[4])/5};
  }
  function finders(bin,w,h){
    const cands=[];
    for(let y=0;y<h;y++){
      let run=[0,0,0,0,0],cur=0,cnt=0,x=0;
      const push=len=>{run.shift();run.push(len);};
      while(x<w){
        const v=bin[y*w+x];
        if(v===cur){cnt++;x++;continue;}
        push(cnt);
        if(cur===1&&run[4]&&run[0]&&ratioOk(run)){
          // el centro es el run del medio (run[2]) que termina antes de run[3],run[4]
          const end=x-run[4]-run[3];
          const cx=Math.round(end-run[2]/2);
          const cv=crossVertical(bin,w,h,cx,y);
          if(cv)cands.push({x:cx,y:Math.round(cv.y),mod:cv.mod});
        }
        cur=v;cnt=1;x++;
      }
    }
    // agrupar candidatos cercanos
    const groups=[];
    cands.forEach(c=>{
      const g=groups.find(g=>Math.abs(g.x-c.x)<=g.mod*2&&Math.abs(g.y-c.y)<=g.mod*2);
      if(g){g.x=(g.x*g.n+c.x)/(g.n+1);g.y=(g.y*g.n+c.y)/(g.n+1);g.mod=(g.mod*g.n+c.mod)/(g.n+1);g.n++;}
      else groups.push({x:c.x,y:c.y,mod:c.mod,n:1});
    });
    return groups.filter(g=>g.n>=2).sort((a,b)=>b.n-a.n).slice(0,8);
  }
  const dist=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
  function orderCorners(p){
    // el vértice opuesto al lado más largo es la esquina superior izquierda
    const d=[dist(p[1],p[2]),dist(p[0],p[2]),dist(p[0],p[1])];
    const i=d.indexOf(Math.max(...d));
    const tl=p[i], rest=p.filter((_,k)=>k!==i);
    // orientación: en coordenadas de imagen la Y crece hacia abajo, así que
    // (TR-TL) x (BL-TL) es positivo — el signo va al revés que en convención matemática
    const v1={x:rest[0].x-tl.x,y:rest[0].y-tl.y}, v2={x:rest[1].x-tl.x,y:rest[1].y-tl.y};
    const cross=v1.x*v2.y-v1.y*v2.x;
    return cross>0?{tl,tr:rest[0],bl:rest[1]}:{tl,tr:rest[1],bl:rest[0]};
  }
  function decodeImage(gray,w,h){
    const thr=otsu(gray);
    const bin=new Uint8Array(w*h);
    // inclusivo: Otsu devuelve el nivel de la propia clase oscura
    for(let i=0;i<bin.length;i++)bin[i]=gray[i]<=thr?1:0;
    const fs=finders(bin,w,h);
    if(fs.length<3)return null;
    // probar las combinaciones más prometedoras de 3 patrones
    for(let a=0;a<fs.length-2;a++)for(let b=a+1;b<fs.length-1;b++)for(let c=b+1;c<fs.length;c++){
      const {tl,tr,bl}=orderCorners([fs[a],fs[b],fs[c]]);
      const mod=(tl.mod+tr.mod+bl.mod)/3;
      if(mod<1)continue;
      let dim=Math.round((dist(tl,tr)/mod+dist(tl,bl)/mod)/2)+7;
      const rem=((dim-17)%4+4)%4;          // el tamaño válido es 17+4k
      dim=rem<=2?dim-rem:dim+(4-rem);
      if(!S2V[dim])continue;
      const ux={x:(tr.x-tl.x)/(dim-7),y:(tr.y-tl.y)/(dim-7)};
      const uy={x:(bl.x-tl.x)/(dim-7),y:(bl.y-tl.y)/(dim-7)};
      const m=[];let bad=false;
      for(let r=0;r<dim&&!bad;r++){
        const row=[];
        for(let col=0;col<dim;col++){
          const fx=col-3, fy=r-3;         // el centro del finder es el módulo 3
          const px=tl.x+ux.x*fx+uy.x*fy, py=tl.y+ux.y*fx+uy.y*fy;
          const xi=Math.round(px), yi=Math.round(py);
          if(xi<0||yi<0||xi>=w||yi>=h){bad=true;break;}
          // voto de vecindad contra el ruido; con módulos finos se muestrea
          // un solo píxel, si no la ventana invade los módulos contiguos
          const rad=mod>=5?1:0;
          let dark=0,tot=0;
          for(let oy=-rad;oy<=rad;oy++)for(let ox=-rad;ox<=rad;ox++){
            const sx=xi+ox,sy=yi+oy;
            if(sx<0||sy<0||sx>=w||sy>=h)continue;
            dark+=bin[sy*w+sx];tot++;
          }
          row.push(dark*2>tot);
        }
        if(!bad)m.push(row);
      }
      if(bad)continue;
      const txt=decodeMatrix(m);
      if(txt!==null)return txt;
    }
    return null;
  }
  function decodeCanvas(ctx,w,h){
    const d=ctx.getImageData(0,0,w,h).data;
    const gray=new Uint8Array(w*h);
    for(let i=0,j=0;i<d.length;i+=4,j++)gray[j]=(d[i]*299+d[i+1]*587+d[i+2]*114)/1000|0;
    return decodeImage(gray,w,h);
  }
  return {decodeMatrix,decodeImage,decodeCanvas};
})();

/* ===================================================================
   Helpers basicos
   =================================================================== */
const el = id => document.getElementById(id);

// Escape para interpolar en HTML. Cubre tambien " y ' porque parte del codigo
// construye atributos, no solo texto entre etiquetas.
function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Nombre completo de una persona, ya escapado.
function NM(p) {
  if (!p) return '';
  return esc(((p.nombre || '') + ' ' + (p.apellido || '')).trim());
}

const fD = ts => new Date(ts).toLocaleDateString('es-PE');
const fT = ts => new Date(ts).toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit' });

// Identificador del dispositivo. No identifica a la persona: sirve para saber
// desde cuantos equipos se abrio una sesion y para la bitacora de puerta.
// Se cachea en memoria: si el almacenamiento esta bloqueado, sin esto cada
// llamada devolveria un identificador distinto y la bitacora de puerta
// mostraria un dispositivo nuevo en cada accion.
let _deviceId = null;
function deviceId() {
  if (_deviceId) return _deviceId;
  try { _deviceId = localStorage.getItem('cf_dev'); } catch (e) {}
  if (!_deviceId) {
    _deviceId = 'DEV-' + Math.random().toString(36).slice(2, 7).toUpperCase();
    try { localStorage.setItem('cf_dev', _deviceId); } catch (e) {}
  }
  return _deviceId;
}

/* ===================================================================
   Navegacion entre pantallas
   =================================================================== */
// Cada pantalla es una <section class="screen" data-sc="nombre">. Se muestra
// una a la vez. Al cambiar de pantalla se apagan las camaras abiertas: dejar
// el video corriendo de fondo agota la bateria y mantiene el led encendido,
// que asusta a la gente.
const streams = {};

function stopCams() {
  Object.keys(streams).forEach(k => {
    try {
      streams[k].stream.getTracks().forEach(t => t.stop());
      clearInterval(streams[k].timer);
    } catch (e) {}
    delete streams[k];
  });
}

let pantallaActual = null;

function go(nombre) {
  const destino = document.querySelector('[data-sc="' + nombre + '"]');
  if (!destino) return;
  stopCams();
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  destino.classList.add('active');
  pantallaActual = nombre;
  // El foco vuelve al titulo para que un lector de pantalla anuncie la pantalla
  // nueva en lugar de quedarse en el boton que se acaba de pulsar.
  const h = destino.querySelector('h1, h2');
  if (h) { h.setAttribute('tabindex', '-1'); h.focus({ preventScroll: true }); }
  const cuerpo = document.querySelector('.vbody');
  if (cuerpo) cuerpo.scrollTop = 0;
  document.dispatchEvent(new CustomEvent('cf:pantalla', { detail: { pantalla: nombre } }));
}

// Delegacion: cualquier elemento con data-go navega. Evita registrar un
// listener por boton.
document.addEventListener('click', ev => {
  const t = ev.target.closest('[data-go]');
  if (t) { ev.preventDefault(); go(t.dataset.go); }
});

/* ===================================================================
   Camara
   =================================================================== */
// BarcodeDetector cuando existe (Android/Chrome). En iPhone no existe -Safari,
// Chrome y Firefox de iOS corren todos sobre WebKit, que no lo implementa-, asi
// que cae al decodificador propio de arriba. Sin eso la camara no funcionaria
// en la mitad del publico de un evento.
async function startCam(boxId, onCode) {
  const box = el(boxId);
  if (!box) return;

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    box.innerHTML = '<div class="off">Este navegador no da acceso a la cámara.<br>Usa el código manual.</div>';
    return;
  }
  box.innerHTML = '<div class="off">Abriendo cámara…</div>';

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false
    });
  } catch (e) {
    const msg = (e && (e.name === 'NotAllowedError' || e.name === 'SecurityError'))
      ? 'Permiso de cámara denegado.<br><span style="opacity:.75;">En iPhone: Ajustes › Safari › Cámara › Preguntar o Permitir. Luego recarga.</span>'
      : (location.protocol !== 'https:' && location.hostname !== 'localhost')
        ? 'La cámara solo funciona sobre HTTPS.'
        : 'No se pudo abrir la cámara.<br>' + (e && e.message ? esc(e.message) : '');
    box.innerHTML = '<div class="off">' + msg + '</div>';
    return;
  }

  box.innerHTML = '<video playsinline muted autoplay></video><div class="reticle"></div>';
  const v = box.querySelector('video');
  v.setAttribute('playsinline', '');          // iOS: sin esto abre a pantalla completa
  v.setAttribute('webkit-playsinline', '');
  v.muted = true;
  v.srcObject = stream;
  try { await v.play(); } catch (e) {}

  let det = null;
  if ('BarcodeDetector' in window) {
    try { det = new BarcodeDetector({ formats: ['qr_code'] }); } catch (e) { det = null; }
  }

  const cv = document.createElement('canvas');
  const cx = cv.getContext('2d', { willReadFrequently: true });
  let busy = false;

  const timer = setInterval(async () => {
    if (busy || v.readyState < 2 || !v.videoWidth) return;
    busy = true;
    try {
      if (det) {
        const c = await det.detect(v);
        if (c.length) { onCode(c[0].rawValue); busy = false; return; }
      }
      const scale = Math.min(1, 540 / Math.max(v.videoWidth, v.videoHeight));
      cv.width = Math.round(v.videoWidth * scale);
      cv.height = Math.round(v.videoHeight * scale);
      cx.drawImage(v, 0, 0, cv.width, cv.height);
      const txt = QRDEC.decodeCanvas(cx, cv.width, cv.height);
      if (txt) onCode(txt);
    } catch (e) {}
    busy = false;
  }, 140);

  streams[boxId] = { stream, timer };
}

/* ===================================================================
   Cliente de la API
   =================================================================== */
const API = (function () {
  const CLAVE_SESION = 'cf_sesion';
  const CLAVE_STAFF = 'cf_staff_token';
  // Clave distinta de la del asistente: en el mismo navegador puede haber una
  // sesion de persona y una de puesto sin pisarse, y sobre todo el token de una
  // no debe poder usarse como el de la otra.
  const CLAVE_EMPRESA = 'cf_sesion_empresa';
  // Sesion de un usuario de staff con nombre propio. Convive con CLAVE_STAFF,
  // que guarda el token de emergencia.
  const CLAVE_STAFF_SESION = 'cf_staff_sesion';

  // localStorage no siempre esta disponible: navegacion privada en algunos
  // Safari, politicas corporativas, o el usuario bloqueando el almacenamiento.
  // Sin reserva, la app perdia la sesion en silencio y el Punto de Ayuda no
  // llegaba a aceptar nunca su token, sin explicar por que.
  //
  // Con la reserva en memoria la app funciona durante la visita; lo que se
  // pierde es la persistencia al cerrar la pestana, y eso se avisa en pantalla.
  const memoria = {};
  let hayAlmacenamiento = true;
  try {
    const p = '__cf_probe';
    localStorage.setItem(p, '1');
    hayAlmacenamiento = localStorage.getItem(p) === '1';
    localStorage.removeItem(p);
  } catch (e) {
    hayAlmacenamiento = false;
  }

  const leer = k => {
    if (!hayAlmacenamiento) return memoria[k] || '';
    try { return localStorage.getItem(k) || ''; } catch (e) { return memoria[k] || ''; }
  };
  const guardar = (k, v) => {
    memoria[k] = v || '';
    if (!hayAlmacenamiento) return;
    try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch (e) {}
  };

  // El token de staff se entrega abriendo la app con ?staff=TOKEN y se limpia
  // de la barra de direcciones al instante, para que no quede en el historial
  // ni en la captura de pantalla que alguien reenvie.
  (function tomarTokenDeLaUrl() {
    try {
      const qs = new URLSearchParams(location.search);
      const t = qs.get('staff');
      if (!t) return;
      guardar(CLAVE_STAFF, t.trim());
      qs.delete('staff');
      history.replaceState(null, '', location.pathname + (qs.toString() ? '?' + qs : '') + location.hash);
    } catch (e) {}
  })();

  function avisarSinRed(hayFallo) {
    const barra = el('offbar');
    if (barra) barra.classList.toggle('on', !!hayFallo);
  }

  // Envoltorio unico de fetch. `auth` decide que credencial se adjunta:
  //   'sesion' -> token de la persona    'staff' -> token del Punto de Ayuda
  async function pedir(url, opts) {
    const o = opts || {};
    const metodo = o.metodo || 'GET';
    const cuerpo = o.cuerpo === undefined ? null : o.cuerpo;
    const auth = o.auth || null;

    const opciones = { method: metodo, headers: {} };
    if (cuerpo !== null) {
      opciones.headers['Content-Type'] = 'application/json';
      opciones.body = JSON.stringify(cuerpo);
    }
    if (auth === 'sesion') {
      const t = leer(CLAVE_SESION);
      if (t) opciones.headers['Authorization'] = 'Bearer ' + t;
    } else if (auth === 'empresa') {
      const t = leer(CLAVE_EMPRESA);
      if (t) opciones.headers['Authorization'] = 'Bearer ' + t;
    } else if (auth === 'staff') {
      // Se prefiere SIEMPRE la sesión de usuario: así la acción queda atribuida
      // a una persona concreta. El token de emergencia solo entra en juego si
      // no hay sesión, que es el caso de crear el primer organizador o de
      // recuperar el acceso cuando alguien se quedó fuera.
      const s = leer(CLAVE_STAFF_SESION);
      if (s) {
        opciones.headers['Authorization'] = 'Bearer ' + s;
      } else {
        const t = leer(CLAVE_STAFF);
        if (t) opciones.headers['X-Admin-Token'] = t;
      }
    }

    let res;
    try {
      res = await fetch(url, opciones);
    } catch (e) {
      avisarSinRed(true);
      // Se distingue "no hay red" de "el servidor dijo que no": en puerta son
      // dos problemas distintos y se resuelven de forma distinta.
      const err = new Error('Sin conexión con el servidor.');
      err.sinRed = true;
      throw err;
    }
    avisarSinRed(false);

    const datos = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(datos.error || 'No pudimos completar la operación.');
      err.status = res.status;
      err.datos = datos;
      throw err;
    }
    return datos;
  }

  return {
    // Las pantallas lo consultan para avisar de que la sesion no sobrevivira
    // al cierre de la pestana.
    almacenamientoPersistente: () => hayAlmacenamiento,
    tieneSesion: () => !!leer(CLAVE_SESION),
    tieneTokenStaff: () => !!leer(CLAVE_STAFF),
    tokenStaff: () => leer(CLAVE_STAFF),
    tieneSesionStaff: () => !!leer(CLAVE_STAFF_SESION),
    guardarSesionStaff: t => guardar(CLAVE_STAFF_SESION, t),
    borrarSesionStaff: () => guardar(CLAVE_STAFF_SESION, ''),
    credencialStaff: () => leer(CLAVE_STAFF_SESION) || leer(CLAVE_STAFF),
    guardarSesion: t => guardar(CLAVE_SESION, t),
    borrarSesion: () => guardar(CLAVE_SESION, ''),
    tieneSesionEmpresa: () => !!leer(CLAVE_EMPRESA),
    guardarSesionEmpresa: t => guardar(CLAVE_EMPRESA, t),
    borrarSesionEmpresa: () => guardar(CLAVE_EMPRESA, ''),
    guardarTokenStaff: t => guardar(CLAVE_STAFF, t),
    pedir: pedir,

    // --- asistente ---
    evento: () => pedir('/api/events/current'),
    registrar: datos => pedir('/api/auth/register', { metodo: 'POST', cuerpo: datos }),
    ingresar: datos => pedir('/api/auth/login', { metodo: 'POST', cuerpo: datos }),
    yo: () => pedir('/api/auth/me', { auth: 'sesion' }),
    cambiarClave: datos => pedir('/api/auth/change-password', { metodo: 'POST', cuerpo: datos, auth: 'sesion' }),
    salir: () => pedir('/api/auth/logout', { metodo: 'POST', auth: 'sesion' }),

    // --- insignias ---
    puestos: () => pedir('/api/empresas'),
    escanearPuesto: (qr, device) => pedir('/api/insignias/scan', {
      metodo: 'POST', cuerpo: { qr: qr, device_id: device }, auth: 'sesion'
    }),
    misInsignias: () => pedir('/api/insignias/mias', { auth: 'sesion' }),

    // --- staff ---
    verificarTicket: datos => pedir('/api/tickets/verify', { metodo: 'POST', cuerpo: datos }),
    checkin: datos => pedir('/api/tickets/checkin', { metodo: 'POST', cuerpo: datos, auth: 'staff' }),
    buscarPorDni: dni => pedir('/api/soporte/buscar', { metodo: 'POST', cuerpo: { dni: dni }, auth: 'staff' }),
    resetClave: datos => pedir('/api/soporte/reset-password', { metodo: 'POST', cuerpo: datos, auth: 'staff' }),
    ultimosCheckins: n => pedir('/api/checkins?limit=' + encodeURIComponent(n || 20), { auth: 'staff' }),

    // --- organizador: puestos y sus QR ---
    puestosConQr: () => pedir('/api/soporte/empresas', { auth: 'staff' }),
    crearPuesto: datos => pedir('/api/soporte/empresas', { metodo: 'POST', cuerpo: datos, auth: 'staff' }),

    // --- cuentas de staff ---
    staffLogin: datos => pedir('/api/staff/login', { metodo: 'POST', cuerpo: datos }),
    staffYo: () => pedir('/api/staff/me', { auth: 'staff' }),
    staffSalir: () => pedir('/api/staff/logout', { metodo: 'POST', auth: 'staff' }),
    staffCambiarClave: datos => pedir('/api/staff/change-password', { metodo: 'POST', cuerpo: datos, auth: 'staff' }),
    staffUsuarios: () => pedir('/api/staff/usuarios', { auth: 'staff' }),
    staffCrearUsuario: datos => pedir('/api/staff/usuarios', { metodo: 'POST', cuerpo: datos, auth: 'staff' }),
    staffReponerClave: id => pedir('/api/staff/usuarios/' + encodeURIComponent(id) + '/clave', { metodo: 'POST', auth: 'staff' }),
    staffActivo: (id, activo) => pedir('/api/staff/usuarios/' + encodeURIComponent(id) + '/activo', { metodo: 'POST', cuerpo: { activo }, auth: 'staff' })
  };
})();

// Permite cargar el token de staff desde la consola si el enlace con ?staff= se
// perdio: iteraSetStaffToken('...')
window.iteraSetStaffToken = function (t) {
  API.guardarTokenStaff(String(t || '').trim());
  return '✓ Token de staff guardado en este dispositivo.';
};
