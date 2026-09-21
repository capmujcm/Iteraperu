'use strict';
/* =============================================================================
   Country Fest - nucleo compartido de la app real
   =============================================================================
   Lo usan asistente.html y staff.html. Contiene:

     1. Codificador de QR propio (el decodificador es jsqr.js, vendorizado)
     2. Camara con lectura de QR
     3. Navegacion entre pantallas
     4. Cliente de la API: sesion de la persona y token de staff
     5. Helpers de escape para HTML

   Sobre el escape: en este proyecto NADA que venga del servidor o de un
   formulario entra en innerHTML sin pasar por esc(). Los nombres de personas
   van siempre por NM(). Es la regla del CLAUDE.md y aqui no hay excepciones.
   ========================================================================== */

/* ===================================================================
   Codificador QR propio — versiones 1-5, EC nivel L.

   Comprobado contra jsQR: lo que genera se lee y devuelve el mismo texto,
   asi que los codigos son estandar y los lee cualquier camara.
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
//
// Quien se registro en la puerta puede no tener nombre todavia: ahi solo se
// pide el documento y la persona completa el resto desde su celular. Devolver
// vacio dejaba un hueco en las tarjetas que parecia un fallo de carga, asi que
// se dice lo que pasa.
function NM(p) {
  if (!p) return '';
  const completo = ((p.nombre || '') + ' ' + (p.apellido || '')).trim();
  if (!completo) return '<span class="muted">Sin nombre aún</span>';
  return esc(completo);
}

// Color que viene del servidor y acaba dentro de un atributo style. esc() evita
// que se escape del atributo, pero no que el valor sea CSS arbitrario: un
// "red;background-image:url(...)" seguiria colandose. Un puesto solo necesita
// poder elegir un color, asi que se exige exactamente eso.
function colorHex(v, porDefecto) {
  return /^#[0-9a-fA-F]{3,8}$/.test(String(v == null ? '' : v)) ? String(v) : porDefecto;
}

/* ===================================================================
   Celebracion / confirmacion a pantalla completa
   =================================================================== */
// La usan el asistente al ganar una insignia y la puerta al validar un
// ingreso. Ocupa la pantalla a proposito: quien sostiene el telefono con una
// cola detras no lee una linea de texto dentro de una tarjeta.
//
// Todo lo que entra aqui viene del servidor, asi que pasa por esc(); el unico
// valor que acaba en un atributo style es el color, y va por colorHex().
const PAPELILLOS = ['#FFDE00', '#E60067', '#00C2FF', '#1CDE96', '#FF9E15'];
let _celebraTimer = null;

function celebrar(o) {
  const op = o || {};
  cerrarCelebracion();

  const capa = document.createElement('div');
  capa.className = 'celebra';
  capa.setAttribute('role', 'alertdialog');
  capa.setAttribute('aria-live', 'assertive');

  const tono = op.tono === 'ok' || op.tono === 'no' ? op.tono : '';

  // Icono: o la medalla del puesto, o una marca grande de resultado.
  const icono = op.emoji !== undefined
    ? '<div class="medal" style="background:linear-gradient(135deg,' +
        colorHex(op.color, '#E60067') + ',#111);">' +
        '<span class="em">' + esc(op.emoji || '🎪') + '</span></div>'
    : '<div class="celebra-marca">' + esc(op.marca || '✓') + '</div>';

  const datos = (op.datos || []).map(function (d) {
    return '<div class="cb-dato"><b>' + esc(d.valor) + '</b>' +
           '<span>' + esc(d.etiqueta) + '</span></div>';
  }).join('');

  capa.innerHTML =
    '<div class="celebra-caja' + (tono ? ' ' + tono : '') + '">' +
      '<div class="celebra-confeti"></div>' +
      '<div class="celebra-halo"></div>' +
      icono +
      '<h3>' + esc(op.titulo || '') + '</h3>' +
      (op.principal ? '<p class="cb-puesto">' + esc(op.principal) + '</p>' : '') +
      (op.secundario ? '<p class="cb-rubro">' + esc(op.secundario) + '</p>' : '') +
      (datos ? '<div class="cb-tickets">' + datos + '</div>' : '') +
      '<button type="button" class="btn btn-line btn-sm cb-cerrar">' +
        esc(op.boton || 'Continuar') + '</button>' +
      (op.pie ? '<p class="cb-pie">' + esc(op.pie) + '</p>' : '') +
    '</div>';

  if (op.confeti) {
    const caja = capa.querySelector('.celebra-confeti');
    for (let i = 0; i < 26; i++) {
      const p = document.createElement('i');
      // Valores numericos generados aqui, nunca contenido de nadie.
      p.style.left = (Math.random() * 100).toFixed(2) + '%';
      p.style.background = PAPELILLOS[i % PAPELILLOS.length];
      p.style.animationDelay = (Math.random() * 0.5).toFixed(2) + 's';
      p.style.animationDuration = (1.1 + Math.random() * 0.8).toFixed(2) + 's';
      p.style.setProperty('--giro', Math.round(360 + Math.random() * 540) + 'deg');
      caja.appendChild(p);
    }
  }

  // Vibracion corta donde exista. En Android confirma el escaneo sin mirar; en
  // iPhone no existe y no pasa nada.
  try {
    if (navigator.vibrate) navigator.vibrate(op.tono === 'no' ? [90, 60, 90] : 45);
  } catch (e) {}

  capa.querySelector('.cb-cerrar').addEventListener('click', cerrarCelebracion);
  capa.addEventListener('click', function (ev) {
    if (ev.target === capa) cerrarCelebracion();
  });

  document.body.appendChild(capa);
  try { capa.querySelector('.cb-cerrar').focus({ preventScroll: true }); } catch (e) {}

  // Se cierra sola: en la puerta nadie va a pulsar un boton entre persona y
  // persona. Un fallo se queda mas tiempo, que es cuando hay que leerlo.
  const espera = op.auto === undefined ? (op.tono === 'no' ? 4200 : 2800) : op.auto;
  if (espera > 0) {
    _celebraTimer = setTimeout(cerrarCelebracion, espera);
  }
}

function cerrarCelebracion() {
  if (_celebraTimer) { clearTimeout(_celebraTimer); _celebraTimer = null; }
  const previa = document.querySelector('.celebra');
  if (previa) previa.remove();
}

// Escape cierra, como cualquier dialogo.
document.addEventListener('keydown', function (ev) {
  if (ev.key === 'Escape') { cerrarCelebracion(); cerrarHoja(); }
});

/* ===================================================================
   Ficha de un puesto
   =================================================================== */
// Lo que el puesto escribe en "Instagram" es texto libre de hasta 80
// caracteres: puede poner "@tupuesto", la URL entera o cualquier cosa,
// incluido un "javascript:". Asi que NUNCA se usa ese valor como href.
//
// Se extrae el identificador -solo letras, numeros, punto, guion y guion
// bajo- y la direccion la componemos nosotros. El esquema y el dominio
// son constantes del codigo, no dato de nadie.
function usuarioRed(v) {
  const limpio = String(v == null ? '' : v)
    .trim()
    .replace(/^https?:\/\/(www\.)?[a-z0-9.-]+\//i, '')  // pegaron la URL entera
    .replace(/^@+/, '')
    .split(/[/?#]/)[0]
    .replace(/[^A-Za-z0-9._-]/g, '')
    .slice(0, 60);
  return limpio || null;
}

// El numero se reduce a digitos y se le antepone el 51 de Peru si viene sin
// prefijo, que es como lo escribe todo el mundo aqui.
function telefonoWa(v) {
  let d = String(v == null ? '' : v).replace(/\D/g, '');
  if (!d) return null;
  if (d.length === 9) d = '51' + d;
  if (d.length < 8 || d.length > 15) return null;
  return d;
}

const REDES = [
  { campo: 'instagram', icono: '📸', nombre: 'Instagram', base: 'https://instagram.com/' },
  { campo: 'facebook', icono: '👍', nombre: 'Facebook', base: 'https://facebook.com/' },
  { campo: 'tiktok', icono: '🎵', nombre: 'TikTok', base: 'https://tiktok.com/@' }
];

function cerrarHoja() {
  const previa = document.querySelector('.hoja');
  if (previa) previa.remove();
}

// p es el puesto tal y como lo devuelve el servidor: puede venir de la
// coleccion de insignias o del catalogo publico, los campos son los mismos.
function abrirFichaPuesto(p) {
  if (!p) return;
  cerrarHoja();

  const cara = p.tiene_logo
    ? '<img src="/api/empresas/' + encodeURIComponent(p.empresa_id || p.id) + '/logo" alt="">'
    : esc(p.emoji || '🎪');

  const enlaces = [];
  REDES.forEach(function (r) {
    const u = usuarioRed(p[r.campo]);
    if (!u) return;
    enlaces.push(
      '<a class="hoja-red" href="' + r.base + encodeURIComponent(u) + '"' +
        ' target="_blank" rel="noopener noreferrer">' +
        '<span class="ic">' + r.icono + '</span>' +
        '<span class="tx">@' + esc(u) + '</span></a>'
    );
  });

  const wa = telefonoWa(p.whatsapp);
  if (wa) {
    enlaces.push(
      '<a class="hoja-red wa" href="https://wa.me/' + encodeURIComponent(wa) + '"' +
        ' target="_blank" rel="noopener noreferrer">' +
        '<span class="ic">💬</span><span class="tx">WhatsApp</span></a>'
    );
  }

  const sub = [p.rubro, p.stand ? 'Stand ' + p.stand : null]
    .filter(Boolean).join(' · ');

  const capa = document.createElement('div');
  capa.className = 'hoja';
  capa.setAttribute('role', 'dialog');
  capa.setAttribute('aria-label', 'Ficha del puesto');

  capa.innerHTML =
    '<div class="hoja-caja">' +
      '<div class="hoja-asa"><i></i></div>' +
      '<div class="hoja-cab">' +
        '<div class="hoja-logo" style="background:' + colorHex(p.color, '#E60067') + '22;">' +
          cara + '</div>' +
        '<div><h3>' + esc(p.nombre || '') + '</h3>' +
          (sub ? '<p>' + esc(sub) + '</p>' : '') + '</div>' +
      '</div>' +
      (p.condicion
        ? '<div class="hoja-promo"><b>Lo que ofrecen</b><span>' + esc(p.condicion) + '</span></div>'
        : '') +
      (p.descripcion ? '<p class="hoja-desc">' + esc(p.descripcion) + '</p>' : '') +
      (enlaces.length
        ? '<div class="hoja-redes">' + enlaces.join('') + '</div>'
        : '<p class="hoja-vacio">Este puesto todavía no ha publicado sus redes.</p>') +
      '<button type="button" class="btn btn-line btn-block btn-sm hoja-pie">Cerrar</button>' +
    '</div>';

  capa.querySelector('.hoja-pie').addEventListener('click', cerrarHoja);
  capa.addEventListener('click', function (ev) {
    if (ev.target === capa) cerrarHoja();
  });

  document.body.appendChild(capa);
  try { capa.querySelector('.hoja-pie').focus({ preventScroll: true }); } catch (e) {}
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

// Generacion de camara. Cada peticion de camara se lleva un numero; si cuando
// el permiso se resuelve ya hay otra peticion mas nueva -o se cambio de
// pantalla- la que llega tarde se apaga sola en vez de quedarse encendida sin
// que nadie la controle. Sin esto, dos toques seguidos en "Escanear" dejaban
// una camara huerfana: el led encendido y la bateria bajando el resto del dia,
// porque stopCams solo puede apagar las que alcanzo a registrar.
let _camGen = 0;

function stopCams() {
  _camGen++;
  Object.keys(streams).forEach(k => {
    try {
      streams[k].stream.getTracks().forEach(t => t.stop());
      clearInterval(streams[k].timer);
      const caja = el(k);
      const v = caja && caja.querySelector('video');
      if (v) v.srcObject = null;
    } catch (e) {}
    delete streams[k];
  });
}

// Volver de segundo plano. iOS suelta la pista de video cuando el telefono se
// bloquea o se cambia de app: al volver, el temporizador sigue corriendo sobre
// un cuadro muerto y la camara no lee nunca mas. Desde fuera no se nota -la
// reticula sigue ahi- y en la puerta eso es el staff apuntando a un QR tras
// otro sin entender por que no pasa nada.
// Se rearma entera en vez de intentar adivinar si sigue sirviendo. Mirar si la
// pista esta "viva" no basta: iOS a veces la reporta activa y el cuadro esta
// congelado igual, y entonces no hay forma de distinguir una camara que lee de
// una que no sin ponerse a comparar pixeles. Volver a abrirla cuesta unas
// decimas y un parpadeo; equivocarse cuesta una puerta parada.
document.addEventListener('visibilitychange', function () {
  if (document.hidden) return;
  Object.keys(streams).forEach(function (boxId) {
    const s = streams[boxId];
    if (!s) return;
    const cb = s.onCode;
    try {
      s.stream.getTracks().forEach(t => t.stop());
      clearInterval(s.timer);
    } catch (e) {}
    delete streams[boxId];
    startCam(boxId, cb);
  });
});

let pantallaActual = null;

function go(nombre) {
  const destino = document.querySelector('[data-sc="' + nombre + '"]');
  if (!destino) return;
  stopCams();
  cerrarCelebracion();
  cerrarHoja();
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
// que se recurre a jsQR. Sin una de las dos vias la camara no funcionaria en la
// mitad del publico de un evento.
//
// Aqui hubo un decodificador escrito a mano. Medido contra jsQR sobre los
// mismos cuadros degradados -giro, desenfoque, reflejo, perspectiva y media
// sombra- leia el 64% frente al 79%. Esa diferencia, en la puerta, es la que
// separa "funciona" de "no funciona": le faltaban correccion de errores
// Reed-Solomon (descartaba el cuadro ante un solo bit mal), umbral local en vez
// de global y correccion de perspectiva. Tres problemas resueltos hace anos que
// no tenia sentido volver a resolver mal.
async function startCam(boxId, onCode) {
  const box = el(boxId);
  if (!box) return;

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    box.innerHTML = '<div class="off">Este navegador no da acceso a la cámara.<br>Usa el código manual.</div>';
    return;
  }

  // Numero de esta peticion. Si cuando la camara se abra ya hay otra mas nueva,
  // esta sobra y se apaga: ver el comentario de _camGen.
  const gen = ++_camGen;

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

  // El permiso puede tardar segundos. Si mientras tanto se cambio de pantalla o
  // se volvio a pedir la camara, esta llega tarde: se apaga y se va.
  if (gen !== _camGen) {
    stream.getTracks().forEach(t => t.stop());
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

  // Si jsQR no llego a cargar y el navegador no trae lector propio, la camara
  // se quedaria encendida sin leer nunca nada. Antes eso era invisible: la
  // persona apuntaba al QR y no pasaba nada, sin explicacion.
  if (!det && typeof jsQR !== 'function') {
    stream.getTracks().forEach(t => t.stop());
    box.innerHTML = '<div class="off">No se pudo cargar el lector de códigos.<br>' +
      'Recarga la página, o escribe el código que aparece bajo el QR.</div>';
    return;
  }

  const cv = document.createElement('canvas');
  const cx = cv.getContext('2d', { willReadFrequently: true });
  let busy = false;

  const timer = setInterval(async () => {
    if (busy || v.readyState < 2 || !v.videoWidth) return;
    // Mientras haya una confirmación en pantalla no se lee nada: si no, la
    // cámara vuelve a enganchar el mismo QR por detrás y el mensaje se
    // reemplaza solo antes de que nadie lo haya leído.
    if (document.querySelector('.celebra')) return;
    busy = true;
    try {
      if (det) {
        const c = await det.detect(v);
        if (c.length) { onCode(c[0].rawValue); busy = false; return; }
      }
      // 720 px y no 540: un QR de 29 modulos leido desde metro y medio cae por
      // debajo de 3 px por modulo si se reduce mas, y ahi ya no lo lee nadie.
      const scale = Math.min(1, 720 / Math.max(v.videoWidth, v.videoHeight));
      cv.width = Math.round(v.videoWidth * scale);
      cv.height = Math.round(v.videoHeight * scale);
      cx.drawImage(v, 0, 0, cv.width, cv.height);

      if (typeof jsQR === 'function') {
        const img = cx.getImageData(0, 0, cv.width, cv.height);
        // Primero se prueba sin invertir, que es el caso normal; si no sale, se
        // reintenta invertido, que es como se ve un QR blanco sobre fondo
        // oscuro o la pantalla de otro telefono en modo noche.
        const r = jsQR(img.data, cv.width, cv.height, { inversionAttempts: 'attemptBoth' });
        if (r && r.data) onCode(r.data);
      }
    } catch (e) {}
    busy = false;
  }, 140);

  // Ultima comprobacion: entre que se pinto el video y se armo el temporizador
  // pudo cambiarse de pantalla. Sin esto quedaria un timer leyendo sobre una
  // camara que ya nadie mira.
  if (gen !== _camGen) {
    clearInterval(timer);
    stream.getTracks().forEach(t => t.stop());
    return;
  }

  // `onCode` se guarda para poder rearmar la camara al volver de segundo plano.
  streams[boxId] = { stream, timer, onCode };
}

/* ===================================================================
   Cliente de la API
   =================================================================== */
const API = (function () {
  // Tiempo máximo de espera de una petición. Generoso -el 4G de un recinto
  // lleno va lento- pero finito: lo que no puede pasar es que una petición
  // colgada deje el lector de QR bloqueado el resto del turno.
  const TIEMPO_MAXIMO_MS = 15000;

  // Hay operaciones que legítimamente tardan más y cortarlas sería peor que
  // esperar. Se pasan con `tiempo` en las opciones de pedir():
  //
  //   * Subir un logo: hasta 4 MB por la red de subida de un celular.
  //   * Importar el padrón: 72 puestos, cada uno con su hash de contraseña.
  //     Si esta se corta, los puestos quedan creados pero se pierden las claves
  //     temporales, que solo se muestran una vez.
  const TIEMPO_LARGO_MS = 120000;

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

    // Corte por tiempo. Sin esto, una peticion que se queda colgada -wifi
    // saturado con 4000 personas dentro- no termina nunca, y como el lector de
    // QR solo se vuelve a armar en el `finally` de quien la llamo, la camara
    // quedaba MUERTA EN SILENCIO: se apunta a un codigo tras otro y no pasa
    // nada, sin error ni aviso. Mejor fallar en 15 segundos y poder reintentar.
    const espera = Number(o.tiempo) > 0 ? Number(o.tiempo) : TIEMPO_MAXIMO_MS;
    const ctrl = (typeof AbortController === 'function') ? new AbortController() : null;
    let corte = null;
    if (ctrl) {
      opciones.signal = ctrl.signal;
      corte = setTimeout(function () { try { ctrl.abort(); } catch (e) {} }, espera);
    }

    let res;
    try {
      res = await fetch(url, opciones);
    } catch (e) {
      avisarSinRed(true);
      // Se distingue "no hay red" de "el servidor dijo que no": en puerta son
      // dos problemas distintos y se resuelven de forma distinta. El corte por
      // tiempo se dice aparte, porque ahi la peticion PUDO haber llegado.
      const expiro = e && (e.name === 'AbortError');
      const err = new Error(expiro
        ? 'El servidor tardó demasiado. Vuelve a intentarlo.'
        : 'Sin conexión con el servidor.');
      err.sinRed = true;
      err.expiro = expiro;
      throw err;
    } finally {
      if (corte) clearTimeout(corte);
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
    // Plazo largo para las operaciones que legitimamente tardan (ver arriba).
    TIEMPO_LARGO_MS: TIEMPO_LARGO_MS,

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
    // (verificarTicket se retiro junto con /api/tickets/verify: era publico,
    // nadie lo usaba y permitia enumerar nombres por codigo de entrada.)
    checkin: datos => pedir('/api/tickets/checkin', { metodo: 'POST', cuerpo: datos, auth: 'staff' }),
    buscarPorDni: dni => pedir('/api/soporte/buscar', { metodo: 'POST', cuerpo: { dni: dni }, auth: 'staff' }),
    resetClave: datos => pedir('/api/soporte/reset-password', { metodo: 'POST', cuerpo: datos, auth: 'staff' }),
    ultimosCheckins: n => pedir('/api/checkins?limit=' + encodeURIComponent(n || 20), { auth: 'staff' }),

    // --- organizador: puestos y sus QR ---
    puestosConQr: () => pedir('/api/soporte/empresas', { auth: 'staff' }),
    crearPuesto: datos => pedir('/api/soporte/empresas', { metodo: 'POST', cuerpo: datos, auth: 'staff' }),
    editarPuesto: (id, datos) => pedir('/api/soporte/empresas/' + encodeURIComponent(id), { metodo: 'PATCH', cuerpo: datos, auth: 'staff' }),
    // Segundo dia del evento: todos vuelven a "pendiente de ingreso".
    reiniciarIngresos: () => pedir('/api/soporte/reiniciar-ingresos', { metodo: 'POST', cuerpo: { confirmar: 'REINICIAR' }, auth: 'staff' }),
    deshacerReinicio: () => pedir('/api/soporte/deshacer-reinicio', { metodo: 'POST', cuerpo: { confirmar: 'DESHACER' }, auth: 'staff' }),

    // --- cuentas de staff ---
    staffLogin: datos => pedir('/api/staff/login', { metodo: 'POST', cuerpo: datos }),
    staffYo: () => pedir('/api/staff/me', { auth: 'staff' }),
    staffSalir: () => pedir('/api/staff/logout', { metodo: 'POST', auth: 'staff' }),
    staffCambiarClave: datos => pedir('/api/staff/change-password', { metodo: 'POST', cuerpo: datos, auth: 'staff' }),
    staffUsuarios: () => pedir('/api/staff/usuarios', { auth: 'staff' }),
    staffCrearUsuario: datos => pedir('/api/staff/usuarios', { metodo: 'POST', cuerpo: datos, auth: 'staff' }),
    staffReponerClave: id => pedir('/api/staff/usuarios/' + encodeURIComponent(id) + '/clave', { metodo: 'POST', auth: 'staff' }),
    staffActivo: (id, activo) => pedir('/api/staff/usuarios/' + encodeURIComponent(id) + '/activo', { metodo: 'POST', cuerpo: { activo }, auth: 'staff' }),
    staffDesbloquear: id => pedir('/api/staff/usuarios/' + encodeURIComponent(id) + '/desbloquear', { metodo: 'POST', auth: 'staff' })
  };
})();

// Permite cargar el token de staff desde la consola si el enlace con ?staff= se
// perdio: iteraSetStaffToken('...')
window.iteraSetStaffToken = function (t) {
  API.guardarTokenStaff(String(t || '').trim());
  return '✓ Token de staff guardado en este dispositivo.';
};
