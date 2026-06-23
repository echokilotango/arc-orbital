/**
 * ARC — Three.js WebGL Scene  (Realistic Visual Overhaul)
 *
 *  - Earth: enhanced GLSL day/night shader, crisp terminator, vivid city lights,
 *    atmospheric scattering limb, specular ocean glint
 *  - Sun: photosphere disk with limb-darkening + corona spikes + bloom
 *  - Moon: lit by sun direction
 *  - Orbit tube: thin, sharp, vivid cyan (sunlit) / magenta (eclipse)
 *  - Ground track: distinct yellow-green, hugs surface, different from orbit
 *  - Proper depth occlusion: back-of-Earth geometry hidden
 *  - Clouds: very slow drift, semi-transparent
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// ── Renderer ──────────────────────────────────────────────────
const canvas = document.getElementById('gl');
const W = () => canvas.offsetWidth;
const H = () => canvas.offsetHeight;

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(W(), H());
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.85;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene  = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, W()/H(), 10, 1e8);
camera.position.set(0, 0, 22000);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.minDistance   = 7000;
controls.maxDistance   = 5e6;
controls.zoomSpeed     = 0.8;

const EARTH_R = 6378.0;  // km — 1 Three.js unit = 1 km

// ══════════════════════════════════════════════════════════════
//  SKYBOX — procedural star field on CubeTexture faces
// ══════════════════════════════════════════════════════════════
function makeSkybox() {
  const SIZE = 1024;
  const rng  = (a, b) => a + Math.random() * (b - a);
  const TEMPS   = ['#c0d0ff','#d8e8ff','#ffffff','#fff8f0','#ffe8c0','#ffd090','#ff9060'];
  const WEIGHTS = [0.02,0.06,0.16,0.24,0.28,0.15,0.09];

  function pickColor() {
    let acc = 0, r = Math.random();
    for (let i = 0; i < WEIGHTS.length; i++) { acc += WEIGHTS[i]; if (r <= acc) return TEMPS[i]; }
    return '#ffffff';
  }

  function drawFace(milky) {
    const c = document.createElement('canvas');
    c.width = c.height = SIZE;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#000008'; ctx.fillRect(0,0,SIZE,SIZE);

    if (milky) {
      // Milky Way band
      const g = ctx.createLinearGradient(SIZE*0.2, SIZE*0.3, SIZE*0.8, SIZE*0.7);
      g.addColorStop(0,  'rgba(60,70,110,0)');
      g.addColorStop(0.5,'rgba(70,80,130,0.07)');
      g.addColorStop(1,  'rgba(60,70,110,0)');
      ctx.fillStyle = g; ctx.fillRect(0,0,SIZE,SIZE);
      // Dust lanes
      for (let d=0;d<8;d++) {
        const y=SIZE*rng(0.3,0.7);
        const gd=ctx.createLinearGradient(0,y-SIZE*0.07,0,y+SIZE*0.07);
        gd.addColorStop(0,'rgba(10,15,40,0)');
        gd.addColorStop(0.5,'rgba(10,15,40,0.08)');
        gd.addColorStop(1,'rgba(10,15,40,0)');
        ctx.fillStyle=gd; ctx.fillRect(0,y-SIZE*0.07,SIZE,SIZE*0.14);
      }
    }

    const nStars = milky ? 2400 : 900;
    for (let s=0;s<nStars;s++) {
      const x = rng(0,SIZE);
      const y = milky
        ? (Math.random()<0.65 ? rng(SIZE*0.25,SIZE*0.75) : rng(0,SIZE))
        : rng(0,SIZE);
      const r   = rng(0.25, Math.random()<0.015 ? 2.8 : 1.2);
      const col = pickColor();
      const alp = rng(0.5, 1.0);

      if (r > 1.6) {
        const gr = ctx.createRadialGradient(x,y,0,x,y,r*5);
        const rgba = col.startsWith('#')
          ? `rgba(${parseInt(col.slice(1,3),16)},${parseInt(col.slice(3,5),16)},${parseInt(col.slice(5,7),16)},${(alp*0.4).toFixed(2)})`
          : col;
        gr.addColorStop(0,rgba); gr.addColorStop(1,'rgba(0,0,0,0)');
        ctx.fillStyle=gr; ctx.beginPath(); ctx.arc(x,y,r*5,0,Math.PI*2); ctx.fill();
      }
      ctx.globalAlpha=alp; ctx.fillStyle=col;
      ctx.beginPath(); ctx.arc(x,y,r,0,Math.PI*2); ctx.fill();
      ctx.globalAlpha=1;
    }
    return c;
  }

  const faces=[drawFace(false),drawFace(true),drawFace(false),drawFace(false),drawFace(true),drawFace(false)];
  const cube = new THREE.CubeTexture(faces);
  cube.needsUpdate = true;
  scene.background = cube;
}
makeSkybox();

// ══════════════════════════════════════════════════════════════
//  LIGHTING
// ══════════════════════════════════════════════════════════════
const ambLight = new THREE.AmbientLight(0x030608, 1.0);
scene.add(ambLight);

const sunLight = new THREE.DirectionalLight(0xfff6e8, 3.2);
sunLight.castShadow = true;
sunLight.shadow.mapSize.width  = 4096;
sunLight.shadow.mapSize.height = 4096;
sunLight.shadow.camera.near = 100;
sunLight.shadow.camera.far  = 800000;
sunLight.shadow.camera.left = sunLight.shadow.camera.bottom = -12000;
sunLight.shadow.camera.right= sunLight.shadow.camera.top   =  12000;
sunLight.shadow.bias = -0.0001;
scene.add(sunLight);

// ══════════════════════════════════════════════════════════════
//  EARTH — High-quality day/night GLSL shader
// ══════════════════════════════════════════════════════════════
const earthGeo = new THREE.SphereGeometry(EARTH_R, 128, 128);
const txLoader  = new THREE.TextureLoader();

// High-res textures from NASA/three-globe CDN
const TEX = {
  day:   '/static/img/earth-day.jpg',
  night: '/static/img/earth-night.jpg',
  spec:  '/static/img/earth-water.png',
  cloud: '/static/img/earth-clouds.png',
};

// Create 1x1 placeholder textures so shader never samples null
function makePlaceholder(r,g,b) {
  const d = new Uint8Array([r,g,b,255]);
  const t = new THREE.DataTexture(d,1,1,THREE.RGBAFormat);
  t.needsUpdate = true;
  return t;
}
const placeholderDay   = makePlaceholder(30, 60, 120);
const placeholderNight = makePlaceholder(0, 0, 0);
const placeholderSpec  = makePlaceholder(0, 0, 0);
const placeholderCloud = makePlaceholder(0, 0, 0);

const earthMat = new THREE.ShaderMaterial({
  uniforms: {
    dayTex:   { value: placeholderDay },
    nightTex: { value: placeholderNight },
    specTex:  { value: placeholderSpec },
    cloudTex: { value: placeholderCloud },
    sunDir:   { value: new THREE.Vector3(1,0,0) },
    cloudOff: { value: 0.0 },
    camPos:   { value: new THREE.Vector3() },
  },
  vertexShader: `
    varying vec2 vUv;
    varying vec3 vNorm;
    varying vec3 vWorldPos;
    void main() {
      vUv      = uv;
      vNorm    = normalize(mat3(modelMatrix) * normal);
      vWorldPos= (modelMatrix * vec4(position, 1.0)).xyz;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: `
    uniform sampler2D dayTex, nightTex, specTex, cloudTex;
    uniform vec3  sunDir;
    uniform float cloudOff;
    uniform vec3  camPos;
    varying vec2  vUv;
    varying vec3  vNorm;
    varying vec3  vWorldPos;

    void main() {
      vec3  N   = normalize(vNorm);
      vec3  L   = normalize(sunDir);
      vec3  V   = normalize(camPos - vWorldPos);
      float NdL = dot(N, L);

      // Sharp but smooth terminator — thin band
      float dayBlend = smoothstep(-0.04, 0.10, NdL);

      // Day texture
      vec4 day   = texture2D(dayTex,  vUv);
      // Night texture — boost city lights significantly
      vec4 night = texture2D(nightTex, vUv);
      vec3 nightC = night.rgb * 4.5;
      // Tint night side slightly blue (earthshine)
      nightC = mix(nightC, nightC * vec3(0.7, 0.85, 1.2), 0.3);

      // Specular ocean glint
      vec4  spec = texture2D(specTex, vUv);
      vec3  H    = normalize(L + V);
      float sp   = pow(max(dot(N, H), 0.0), 120.0) * spec.r * dayBlend * 1.6;
      vec3  spCol = vec3(1.0, 0.97, 0.90) * sp;

      // Clouds disabled (no texture available)
      float cld = 0.0;
      float cldShadow = 1.0;

      // Base surface colour
      vec3 col = mix(nightC, day.rgb * cldShadow + spCol, dayBlend);

      // Overlay white cloud tops on day side, dim on night
      col = mix(col, vec3(1.0), cld * 0.85 * dayBlend);
      // Faint cloud glow from city lights on night side
      col += vec3(0.9, 0.85, 0.7) * cld * 0.03 * (1.0 - dayBlend);

      // Atmospheric scattering limb glow
      float rim = 1.0 - max(dot(V, N), 0.0);
      rim = pow(rim, 3.5);
      // Day limb: blue-white atmosphere
      vec3 atmDay   = vec3(0.25, 0.55, 1.0)  * 1.4;
      // Night limb: very faint deep blue
      vec3 atmNight = vec3(0.02, 0.05, 0.18) * 0.8;
      col += rim * mix(atmNight, atmDay, dayBlend) * 1.1;

      gl_FragColor = vec4(col, 1.0);
    }`,
});

function loadTex(url, key, srgb) {
  txLoader.load(url, t => {
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = renderer.capabilities.getMaxAnisotropy();
    earthMat.uniforms[key].value = t;
    earthMat.needsUpdate = true;
  });
}
loadTex(TEX.day,   'dayTex',   true);
loadTex(TEX.night, 'nightTex', true);
loadTex(TEX.spec,  'specTex',  false);
loadTex(TEX.cloud, 'cloudTex', false);

const earth = new THREE.Mesh(earthGeo, earthMat);
earth.renderOrder = 0;
scene.add(earth);

// Occluder: writes depth so back-side orbit/satellite hidden
const occluder = new THREE.Mesh(
  new THREE.SphereGeometry(EARTH_R * 0.999, 64, 64),
  new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: true })
);
occluder.renderOrder = 1;
scene.add(occluder);



// ══════════════════════════════════════════════════════════════
//  SUN — photosphere + corona + bloom
// ══════════════════════════════════════════════════════════════
const SUN_VIZ_DIST = EARTH_R * 600;
// Real angular radius of sun ≈ 0.267° → tan(0.267°) ≈ 0.00466
// Use slightly larger for visibility: 0.006
const SUN_VIZ_R    = SUN_VIZ_DIST * 0.006;

let sunGroup = new THREE.Group();
scene.add(sunGroup);

function buildSun(dir) {
  while (sunGroup.children.length) sunGroup.remove(sunGroup.children[0]);
  const pos = dir.clone().multiplyScalar(SUN_VIZ_DIST);
  sunLight.position.copy(pos);

  // 1. Photosphere — sprite with transparent background, limb-darkening + granulation
  const PS = 512, pc = document.createElement('canvas');
  pc.width = pc.height = PS;
  const px = pc.getContext('2d');
  const cx = PS/2, cr = PS/2 - 2;
  // Transparent background — no black fill
  px.clearRect(0,0,PS,PS);
  // Hard disk clip so edges are sharp
  px.save();
  px.beginPath(); px.arc(cx,cx,cr,0,Math.PI*2); px.clip();
  // Limb darkening radial gradient
  const pg = px.createRadialGradient(cx,cx,0,cx,cx,cr);
  pg.addColorStop(0.00,'rgba(255,255,245,1)');
  pg.addColorStop(0.20,'rgba(255,250,210,1)');
  pg.addColorStop(0.50,'rgba(255,220,120,1)');
  pg.addColorStop(0.75,'rgba(255,170,45,1)');
  pg.addColorStop(0.90,'rgba(240,110,15,1)');
  pg.addColorStop(0.97,'rgba(200,60,5,1)');
  pg.addColorStop(1.00,'rgba(140,20,0,1)');
  px.fillStyle=pg; px.fillRect(0,0,PS,PS);
  // Granulation cells
  for (let g=0;g<500;g++) {
    const gx=cx+(Math.random()-0.5)*cr*1.9, gy=cx+(Math.random()-0.5)*cr*1.9;
    const dd=Math.sqrt((gx-cx)**2+(gy-cx)**2);
    if(dd>cr*0.96) continue;
    const gr2=Math.random()*cr*0.06+cr*0.015;
    const bright=Math.random()>0.42;
    const alp=(0.03+Math.random()*0.06)*(1-dd/cr);
    const col=bright?`rgba(255,255,220,${alp})`:`rgba(120,40,0,${alp*0.5})`;
    const gg2=px.createRadialGradient(gx,gy,0,gx,gy,gr2);
    gg2.addColorStop(0,col); gg2.addColorStop(1,'rgba(0,0,0,0)');
    px.fillStyle=gg2; px.beginPath(); px.arc(gx,gy,gr2,0,Math.PI*2); px.fill();
  }
  px.restore();
  const core = new THREE.Sprite(new THREE.SpriteMaterial({
    map: new THREE.CanvasTexture(pc),
    transparent: true, depthWrite: false, depthTest: true,
    blending: THREE.NormalBlending,
    sizeAttenuation: true,
  }));
  core.position.copy(pos);
  // Scale sprite so it matches SUN_VIZ_R apparent size
  core.scale.set(SUN_VIZ_R*2, SUN_VIZ_R*2, 1);
  sunGroup.add(core);

  // 2. Inner corona + spike rays
  const CS=512, cc=document.createElement('canvas');
  cc.width=cc.height=CS;
  const cx2=CS/2, ctx2=cc.getContext('2d');
  const cg=ctx2.createRadialGradient(cx2,cx2,0,cx2,cx2,cx2);
  cg.addColorStop(0.00,'rgba(255,255,220,1)');
  cg.addColorStop(0.03,'rgba(255,230,130,0.92)');
  cg.addColorStop(0.09,'rgba(255,170,45,0.52)');
  cg.addColorStop(0.20,'rgba(255,110,12,0.20)');
  cg.addColorStop(0.42,'rgba(255,60,0,0.07)');
  cg.addColorStop(0.70,'rgba(200,30,0,0.02)');
  cg.addColorStop(1.00,'rgba(0,0,0,0)');
  ctx2.fillStyle=cg; ctx2.fillRect(0,0,CS,CS);
  // Spike rays
  for (let sp=0;sp<18;sp++) {
    const ang=(sp/18)*Math.PI*2;
    const major=sp%2===0;
    const len=cx2*(major?(0.52+Math.random()*0.38):(0.25+Math.random()*0.18));
    const wid=cx2*(major?0.018:0.009);
    const ex=cx2+Math.cos(ang)*len, ey=cx2+Math.sin(ang)*len;
    const nx=-Math.sin(ang)*wid, ny=Math.cos(ang)*wid;
    const alp=major?0.20:0.10;
    const sg=ctx2.createLinearGradient(cx2,cx2,ex,ey);
    sg.addColorStop(0,`rgba(255,240,180,${alp})`);
    sg.addColorStop(0.45,`rgba(255,180,60,${alp*0.45})`);
    sg.addColorStop(1,'rgba(255,100,0,0)');
    ctx2.fillStyle=sg;
    ctx2.beginPath();
    ctx2.moveTo(cx2+nx,cx2+ny); ctx2.lineTo(ex,ey); ctx2.lineTo(cx2-nx,cx2-ny);
    ctx2.closePath(); ctx2.fill();
  }
  const corona = new THREE.Sprite(new THREE.SpriteMaterial({
    map:new THREE.CanvasTexture(cc), transparent:true, depthWrite:false, depthTest:true, blending:THREE.AdditiveBlending
  }));
  corona.position.copy(pos);
  corona.scale.set(SUN_VIZ_R*20, SUN_VIZ_R*20, 1);
  sunGroup.add(corona);

  // 3. Wide bloom
  const bc=document.createElement('canvas'); bc.width=bc.height=256;
  const bx=bc.getContext('2d');
  const bg=bx.createRadialGradient(128,128,1,128,128,128);
  bg.addColorStop(0,'rgba(255,230,120,0.40)');
  bg.addColorStop(0.18,'rgba(255,160,30,0.12)');
  bg.addColorStop(0.45,'rgba(255,80,0,0.04)');
  bg.addColorStop(1,'rgba(0,0,0,0)');
  bx.fillStyle=bg; bx.fillRect(0,0,256,256);
  const bloom = new THREE.Sprite(new THREE.SpriteMaterial({
    map:new THREE.CanvasTexture(bc), transparent:true, depthWrite:false, depthTest:true, blending:THREE.AdditiveBlending
  }));
  bloom.position.copy(pos);
  bloom.scale.set(SUN_VIZ_R*55, SUN_VIZ_R*55, 1);
  sunGroup.add(bloom);

  // 4. Diffraction cross
  const fc=document.createElement('canvas'); fc.width=fc.height=256;
  const fx=fc.getContext('2d');
  for(let s=0;s<6;s++){
    const ang=(s/6)*Math.PI;
    const x0=128+Math.cos(ang)*128, y0=128+Math.sin(ang)*128;
    const x1=128-Math.cos(ang)*128, y1=128-Math.sin(ang)*128;
    const sg=fx.createLinearGradient(x0,y0,128,128);
    sg.addColorStop(0,'rgba(255,255,200,0)');
    sg.addColorStop(0.65,'rgba(255,245,170,0.06)');
    sg.addColorStop(1,'rgba(255,235,130,0.14)');
    fx.strokeStyle=sg; fx.lineWidth=1.8;
    fx.beginPath(); fx.moveTo(x0,y0); fx.lineTo(x1,y1); fx.stroke();
  }
  const flare = new THREE.Sprite(new THREE.SpriteMaterial({
    map:new THREE.CanvasTexture(fc), transparent:true, depthWrite:false, depthTest:true, blending:THREE.AdditiveBlending
  }));
  flare.position.copy(pos);
  flare.scale.set(SUN_VIZ_R*35, SUN_VIZ_R*35, 1);
  sunGroup.add(flare);
}

buildSun(new THREE.Vector3(1,0,0));

// ══════════════════════════════════════════════════════════════
//  MOON
// ══════════════════════════════════════════════════════════════
const MOON_VIZ_DIST = EARTH_R * 45;
const moonMesh = new THREE.Mesh(
  new THREE.SphereGeometry(EARTH_R*0.27*1.8, 48, 48),
  new THREE.MeshStandardMaterial({ color:0x9a9aaa, roughness:0.92, metalness:0.0 })
);
scene.add(moonMesh);

// Shadow cone removed — eclipse detection is handled purely in physics/shader

// ══════════════════════════════════════════════════════════════
//  ORBIT LINE — sharp, thin, vivid
//  Orbit:       bright cyan (#00f5ff) sunlit / bright magenta (#ff0090) eclipse
//  Ground track: vivid yellow-green (#aaff00) sunlit / orange (#ff6600) eclipse
//  Uses thin tube (r=14km, 8 sides) — crisp & clearly visible
// ══════════════════════════════════════════════════════════════
let orbitMesh = null, groundMesh = null;

// Vivid, clearly distinguishable colours
const ORBIT_SUNLIT  = new THREE.Color(0x00eeff);   // bright cyan
const ORBIT_ECLIPSE = new THREE.Color(0xff0088);   // bright magenta
const GTRACK_SUNLIT  = new THREE.Color(0x88ff00);  // vivid lime-green
const GTRACK_ECLIPSE = new THREE.Color(0xff6600);  // orange

function buildTubeMesh(pts, colorPerPt, tubeR, tubeSeg) {
  const N = pts.length;
  if (N < 2) return null;

  const verts=[], colors=[], idx=[];
  let prevNorm = null;
  const ringStarts = [];

  for (let i=0; i<N; i++) {
    const p   = new THREE.Vector3(...pts[i]);
    const col = colorPerPt[i];

    let tang;
    if (i < N-1) {
      tang = new THREE.Vector3(...pts[i+1]).sub(p).normalize();
    } else {
      tang = p.clone().sub(new THREE.Vector3(...pts[i-1])).normalize();
    }

    let norm;
    if (!prevNorm) {
      norm = new THREE.Vector3(0,1,0);
      if (Math.abs(tang.dot(norm))>0.9) norm.set(1,0,0);
      norm = new THREE.Vector3().crossVectors(tang, norm).normalize();
      norm = new THREE.Vector3().crossVectors(norm, tang).normalize();
    } else {
      norm = prevNorm.clone();
      norm.sub(tang.clone().multiplyScalar(norm.dot(tang))).normalize();
    }
    prevNorm = norm.clone();

    const binorm = new THREE.Vector3().crossVectors(tang, norm).normalize();
    ringStarts.push(verts.length / 3);
    for (let s=0; s<tubeSeg; s++) {
      const ang = (s/tubeSeg)*Math.PI*2;
      const v = p.clone()
        .addScaledVector(norm,   Math.cos(ang)*tubeR)
        .addScaledVector(binorm, Math.sin(ang)*tubeR);
      verts.push(v.x,v.y,v.z);
      colors.push(col.r,col.g,col.b);
    }
  }

  for (let i=0; i<N-1; i++) {
    const a=ringStarts[i], b=ringStarts[i+1];
    for (let s=0; s<tubeSeg; s++) {
      const s1=(s+1)%tubeSeg;
      idx.push(a+s,b+s,a+s1, b+s,b+s1,a+s1);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts,3));
  geo.setAttribute('color',    new THREE.Float32BufferAttribute(colors,3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

function buildOrbitAndGroundTrack(positions, eclipseMask) {
  if (orbitMesh)  { scene.remove(orbitMesh);  orbitMesh  = null; }
  if (groundMesh) { scene.remove(groundMesh); groundMesh = null; }

  const N = positions.length;
  if (N < 2) return;

  // ── Orbit tube ──
  const orbitColors = positions.map((_,i) => eclipseMask[i] ? ORBIT_ECLIPSE : ORBIT_SUNLIT);
  const orbitGeo = buildTubeMesh(positions, orbitColors, 16, 10);
  if (orbitGeo) {
    orbitMesh = new THREE.Mesh(orbitGeo,
      new THREE.MeshBasicMaterial({ vertexColors:true, depthTest:true, depthWrite:true })
    );
    orbitMesh.renderOrder = 2;
    scene.add(orbitMesh);
  }

  // ── Ground track — project to surface + tiny elevation ──
  const groundPts  = [];
  const groundCols = [];
  for (let i=0; i<N; i++) {
    const v = new THREE.Vector3(...positions[i]).normalize().multiplyScalar(EARTH_R + 3);
    groundPts.push([v.x, v.y, v.z]);
    groundCols.push(eclipseMask[i] ? GTRACK_ECLIPSE : GTRACK_SUNLIT);
  }
  const groundGeo = buildTubeMesh(groundPts, groundCols, 6, 6);
  if (groundGeo) {
    groundMesh = new THREE.Mesh(groundGeo,
      new THREE.MeshBasicMaterial({ vertexColors:true, depthTest:true, depthWrite:true,
        polygonOffset:true, polygonOffsetFactor:-1, polygonOffsetUnits:-1 })
    );
    groundMesh.renderOrder = 3;
    scene.add(groundMesh);
  }
}

// ══════════════════════════════════════════════════════════════
//  SATELLITE MESH
// ══════════════════════════════════════════════════════════════
const satGroup = new THREE.Group();
satGroup.renderOrder = 4;
scene.add(satGroup);
satGroup.visible = false;

const BODY = 240;

const satBody = new THREE.Mesh(
  new THREE.BoxGeometry(BODY, BODY*1.1, BODY*1.5),
  new THREE.MeshStandardMaterial({ color:0xc0ccd8, metalness:0.85, roughness:0.18, emissive:0x223344, emissiveIntensity:0.4 })
);
satGroup.add(satBody);

const PW=BODY*2.2, PH=BODY*0.75, PD=BODY*0.04;
const panelMat = new THREE.MeshStandardMaterial({
  color:0x0f2a5a, metalness:0.55, roughness:0.28, emissive:0x0a2040, emissiveIntensity:0.5
});
[-1,1].forEach(side => {
  const p = new THREE.Mesh(new THREE.BoxGeometry(PW,PH,PD), panelMat);
  p.position.set(side*(BODY*0.5+PW*0.5),0,0);
  satGroup.add(p);
  // Cell lines
  const g = new THREE.Mesh(
    new THREE.BoxGeometry(PW*0.97,PH*0.97,PD*0.4),
    new THREE.MeshBasicMaterial({color:0x1a3870, wireframe:true})
  );
  g.position.copy(p.position);
  satGroup.add(g);
});

const ant = new THREE.Mesh(
  new THREE.CylinderGeometry(6,6,BODY*0.9,6),
  new THREE.MeshStandardMaterial({color:0x9098a8, metalness:0.9, roughness:0.18})
);
ant.position.set(0, BODY*0.55+BODY*0.45, 0);
satGroup.add(ant);

const dish = new THREE.Mesh(
  new THREE.ConeGeometry(BODY*0.3, BODY*0.2, 20, 1, true),
  new THREE.MeshStandardMaterial({color:0xdde8f0, metalness:0.72, roughness:0.18, side:THREE.DoubleSide})
);
dish.position.set(0, BODY*0.55+BODY*0.9+BODY*0.1, 0);
satGroup.add(dish);

// Glow sprite
const gc=document.createElement('canvas'); gc.width=gc.height=128;
const gctx=gc.getContext('2d');
const gg=gctx.createRadialGradient(64,64,3,64,64,64);
gg.addColorStop(0,'rgba(100,255,160,1)');
gg.addColorStop(0.28,'rgba(60,210,120,0.35)');
gg.addColorStop(1,'rgba(0,0,0,0)');
gctx.fillStyle=gg; gctx.fillRect(0,0,128,128);
const satGlowMat = new THREE.SpriteMaterial({
  map:new THREE.CanvasTexture(gc), transparent:true, depthWrite:false, blending:THREE.AdditiveBlending
});
const satGlow = new THREE.Sprite(satGlowMat);
satGlow.scale.set(BODY*6,BODY*6,1);
satGroup.add(satGlow);

const satBodyMat = satBody.material;

// ══════════════════════════════════════════════════════════════
//  ANIMATION STATE
// ══════════════════════════════════════════════════════════════
let positions=[], eclipses=[], playing=false, animIdx=0, lastTs=0;
const ANIM_DUR = 16.0;

const btnPlay  = document.getElementById('btn-play');
const timeline = document.getElementById('timeline');
const tLbl     = document.getElementById('t-lbl');

btnPlay.addEventListener('click', ()=>{
  playing=!playing;
  btnPlay.textContent=playing?'⏸':'▶';
});

timeline.addEventListener('input', ()=>{
  playing=false; btnPlay.textContent='▶';
  animIdx=Math.round(+timeline.value/100*Math.max(0,positions.length-1));
  moveSat(animIdx);
});

function moveSat(i) {
  if (!positions.length) return;
  const ci = Math.max(0, Math.min(Math.floor(i), positions.length-1));
  const p  = positions[ci];
  satGroup.position.set(p[0],p[1],p[2]);

  if (ci < positions.length-1) {
    const nxt = positions[ci+1];
    const vel = new THREE.Vector3(nxt[0]-p[0],nxt[1]-p[1],nxt[2]-p[2]).normalize();
    const up  = new THREE.Vector3(...p).normalize();
    const sid = vel.clone().cross(up).normalize();
    satGroup.setRotationFromMatrix(new THREE.Matrix4().makeBasis(sid, up, vel.negate()));
  }

  const inEcl = eclipses[ci]||false;
  satBodyMat.color.setHex(inEcl?0x1a1e24:0xc0ccd8);
  panelMat.emissive.setHex(inEcl?0x000000:0x081228);
  satGlowMat.opacity = inEcl?0.0:0.75;

  const ei = document.getElementById('ecl-ind');
  if (ei) { ei.textContent=inEcl?'🌑  In Shadow':'☀️  Sunlit'; ei.className=inEcl?'in-shadow':'sunlit'; }

  const pct=Math.round(ci/Math.max(1,positions.length-1)*100);
  timeline.value=pct; tLbl.textContent=pct+'%';

  // ── FIX 2: Update true anomaly slider live ──
  if (typeof window.updateNuDisplay === 'function') {
    window.updateNuDisplay(ci);
  }
}

// ══════════════════════════════════════════════════════════════
//  ORBIT DATA EVENT
// ══════════════════════════════════════════════════════════════
window.addEventListener('orbitData', e => {
  const d=e.detail;
  positions=d.positions;
  eclipses=d.eclipse;
  animIdx=0; playing=true; btnPlay.textContent='⏸';

  const sunDir=new THREE.Vector3(...d.sun_hat);
  earthMat.uniforms.sunDir.value.copy(sunDir);
  buildSun(sunDir);

  const moonDir=new THREE.Vector3(...d.moon_hat);
  moonMesh.position.copy(moonDir.multiplyScalar(MOON_VIZ_DIST));

  buildOrbitAndGroundTrack(positions, eclipses);

  satGroup.visible=true;
  moveSat(0);

  const maxR=Math.max(...positions.map(p=>Math.sqrt(p[0]**2+p[1]**2+p[2]**2)));
  camera.position.set(0, maxR*0.45, maxR*1.85);
  controls.target.set(0,0,0);
  controls.update();
});

// ══════════════════════════════════════════════════════════════
//  RENDER LOOP
// ══════════════════════════════════════════════════════════════
let cloudOff=0;
function animate(ts) {
  requestAnimationFrame(animate);

  // Very slow cloud drift — realistic (full rotation ~7 days)
  cloudOff += 0.00000025;
  earthMat.uniforms.cloudOff.value = cloudOff;
  earthMat.uniforms.camPos.value.copy(camera.position);

  if (playing && positions.length) {
    const dt   = (ts-lastTs)/1000;
    const step = (dt/ANIM_DUR)*positions.length;
    animIdx    = (animIdx+step)%positions.length;
    moveSat(animIdx);
  }
  lastTs=ts;
  controls.update();
  renderer.render(scene,camera);
}
requestAnimationFrame(animate);

window.addEventListener('resize', ()=>{
  camera.aspect=W()/H();
  camera.updateProjectionMatrix();
  renderer.setSize(W(),H());
});
