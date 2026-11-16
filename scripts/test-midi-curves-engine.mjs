/** Testa encaminhamento MIDI e envelope com relógio/vozes fake; sem dispositivo físico. */
import {build} from 'esbuild'; import assert from 'node:assert/strict';import path from 'node:path';import os from 'node:os';import {pathToFileURL} from 'node:url';
const mocks={
  './MrqLayerVoice': `export class MrqLayerVoice { constructor(){this.output={connect(){}};this.name='Teste';globalThis.__voice=this;this.events=[]} async load(){return [{value:'p',label:'P'}]} noteOn(n,v){this.events.push(['on',n,v])} noteOff(n,s){this.events.push(['off',n,s])} allNotesOff(){} setPitchBend(){} dispose(){} selectPreset(){} }`,
  './liveFxChain': `export class LiveFxChain {constructor(){this.input={};this.output={}} setParams(){} setNoteDensity(){} dispose(){} }`,
  './mrqFormat': `export async function mrqReadMetadata(){return {instrument:{presets:[]}}}`
};
const outfile=path.join(os.tmpdir(),`mrq-midi-engine-${Date.now()}.cjs`);
await build({entryPoints:['src/audio/rack/LiveInstrumentEngine.ts'],outfile,bundle:true,platform:'node',format:'cjs',plugins:[{name:'stubs',setup(b){b.onResolve({filter:/^\.\/(MrqLayerVoice|liveFxChain|mrqFormat)$/},a=>({path:a.path,namespace:'mock'}));b.onLoad({filter:/.*/,namespace:'mock'},a=>({contents:mocks[a.path],loader:'js'}))}}]});
const {LiveInstrumentEngine}=await import(pathToFileURL(outfile));
const normal = (await import(pathToFileURL((await (async()=>{let out=path.join(os.tmpdir(),`mrq-params-${Date.now()}.cjs`);await build({entryPoints:['src/audio/rack/liveControls.ts'],outfile:out,bundle:true,platform:'node',format:'cjs'});return out;})())))).defaultLiveParams();
const ramps=[]; const param={value:1,cancelScheduledValues(){},setValueAtTime(){},linearRampToValueAtTime(v,t){ramps.push([v,t])}};const ctx={currentTime:0,createGain:()=>({gain:param,connect(){},disconnect(){}})};
const e=new LiveInstrumentEngine(ctx, normal); await e.load('fake');const voice=globalThis.__voice;
e.noteOn(60,64);e.noteOn(62,90);e.noteOff(60,0);assert.deepEqual(voice.events.at(-1),['off',60,1], 'padrão mantém release de voz');e.noteOff(62,127);assert.equal(ramps.at(-1)[1],normal.releaseMs/1000);
e.allNotesOff();e.setParams({...normal,noteOffLow:0,noteOffMid:64,noteOffHigh:127,releaseMs:1000});voice.events=[];e.noteOn(60,64);e.noteOn(62,80);e.noteOff(60,0);assert.deepEqual(voice.events.at(-1),['off',60,0], 'release individual conforme noteoff');e.noteOff(62,64);assert(Math.abs(ramps.at(-1)[1]-(64/127))<1e-10,'gate global conforme noteoff');
e.allNotesOff();e.setParams(normal);voice.events=[];e.setSustainPedalValue(127);e.noteOn(60,80);e.noteOn(62,80);e.noteOff(60);e.noteOff(62);assert.equal(voice.events.filter(x=>x[0]==='off').length,0,'pedal segura todas as notas');e.setSustainPedalValue(0);await new Promise(r=>setTimeout(r,normal.releaseMs+30));assert.deepEqual(voice.events.filter(x=>x[0]==='off').map(x=>x[1]).sort(),[60,62]);
e.allNotesOff();e.setParams({...normal,pedalReverse:1});voice.events=[];e.setSustainPedalValue(0);e.noteOn(60,80);e.noteOff(60);assert.equal(voice.events.filter(x=>x[0]==='off').length,0,'pedal invertido segura');e.setSustainPedalValue(127);await new Promise(r=>setTimeout(r,normal.releaseMs+30));assert.equal(voice.events.filter(x=>x[0]==='off').length,1);e.dispose();console.log('4 testes de integração do motor MIDI passaram.');
