/**
 * Hook de medição de nível L/R em tempo real pro Auto Sampler — mostra de
 * verdade o sinal chegando do dispositivo de entrada ENQUANTO o usuário
 * ajusta o Input Gain, em vez de um slider "cego" sem feedback (ver
 * screenshots do bonedo.de na conversa: dois medidores de barra ao lado do
 * slider de ganho).
 *
 * Abre o PRÓPRIO stream de monitoramento (`getUserMedia` + `AudioContext`
 * independentes dos usados por `AutoSamplerSession` durante a captura de
 * verdade) — nunca compartilha o stream da sessão de gravação, e é sempre
 * parado (`enabled=false`) ANTES de `session.run()` começar, pra não
 * disputar o mesmo dispositivo de áudio com a gravação real (alguns
 * drivers/SOs não permitem dois consumidores simultâneos do mesmo
 * dispositivo de entrada).
 */
import { useEffect, useRef, useState } from 'react';

export interface StereoLevelDb {
  l: number;
  r: number;
}

const FLOOR_DB = -60;
const SILENCE: StereoLevelDb = { l: FLOOR_DB, r: FLOOR_DB };

function rmsToDb(rms: number): number {
  if (rms <= 0) return FLOOR_DB;
  const db = 20 * Math.log10(rms);
  return Math.max(FLOOR_DB, Math.min(0, db));
}

function channelRms(buf: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < buf.length; i += 1) sum += buf[i] * buf[i];
  return Math.sqrt(sum / buf.length);
}

export function useInputLevelMeter(deviceId: string, enabled: boolean, gainDb: number): { levels: StereoLevelDb; error: string | null } {
  const [levels, setLevels] = useState<StereoLevelDb>(SILENCE);
  const [error, setError] = useState<string | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);

  // Atualiza o ganho do monitor ao vivo sem reabrir o stream — reflete o
  // mesmo Input Gain que será de fato aplicado na captura (ver applyGainDb
  // em autoSamplerEngine.ts), pra o medidor ser um preview fiel.
  useEffect(() => {
    if (gainNodeRef.current) {
      gainNodeRef.current.gain.value = Math.pow(10, gainDb / 20);
    }
  }, [gainDb]);

  useEffect(() => {
    if (!enabled || !deviceId) {
      setLevels(SILENCE);
      return;
    }
    let cancelled = false;
    let stream: MediaStream | null = null;
    let ctx: AudioContext | null = null;
    let raf = 0;
    setError(null);

    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: deviceId } }, video: false });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        ctx = new AudioContext();
        const source = ctx.createMediaStreamSource(stream);
        const gainNode = ctx.createGain();
        gainNode.gain.value = Math.pow(10, gainDb / 20);
        gainNodeRef.current = gainNode;
        const splitter = ctx.createChannelSplitter(2);
        const analyserL = ctx.createAnalyser();
        const analyserR = ctx.createAnalyser();
        analyserL.fftSize = 1024;
        analyserR.fftSize = 1024;
        source.connect(gainNode);
        gainNode.connect(splitter);
        const inputChannels = source.channelCount;
        splitter.connect(analyserL, 0);
        splitter.connect(analyserR, inputChannels > 1 ? 1 : 0); // mono: mostra o mesmo nível nos dois medidores.

        const bufL = new Float32Array(analyserL.fftSize);
        const bufR = new Float32Array(analyserR.fftSize);

        function tick() {
          if (cancelled) return;
          analyserL.getFloatTimeDomainData(bufL);
          analyserR.getFloatTimeDomainData(bufR);
          setLevels({ l: rmsToDb(channelRms(bufL)), r: rmsToDb(channelRms(bufR)) });
          raf = requestAnimationFrame(tick);
        }
        tick();
      } catch (err) {
        if (!cancelled) {
          const message = err instanceof Error ? err.message : String(err);
          setError(`Não foi possível abrir o medidor de nível: ${message}`);
        }
      }
    })();

    return () => {
      cancelled = true;
      if (raf) cancelAnimationFrame(raf);
      gainNodeRef.current = null;
      stream?.getTracks().forEach((t) => t.stop());
      void ctx?.close().catch(() => {});
      setLevels(SILENCE);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceId, enabled]);

  return { levels, error };
}
