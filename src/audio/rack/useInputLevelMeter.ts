/**
 * Hook de medição de nível L/R em tempo real pro Auto Sampler — mostra de
 * verdade o sinal chegando do dispositivo escolhido ENQUANTO o usuário
 * ajusta o Input Gain ou grava as notas, tanto para entradas de microfone /
 * cabo virtual (`getUserMedia`) quanto para o loopback nativo do sistema
 * (`loopback_start` + `loopback_get_levels`, ver `loopback_audio.rs`).
 *
 * Para entradas `getUserMedia`, abre um stream próprio e para (`enabled=false`)
 * antes de `session.run()` começar pra não disputar o mesmo dispositivo de
 * captura com a sessão de gravação. Para o loopback nativo, compartilha a
 * mesma `LoopbackSession` do backend Rust (`loopback_start` reutiliza a
 * sessão aberta pro mesmo dispositivo de saída), então o medidor VU continua
 * funcionando ao vivo antes, durante e depois da captura — e, se o
 * dispositivo de saída estiver temporariamente bloqueado em Modo Exclusivo
 * (`0x8889000A`), tenta reconectar automaticamente a cada 2s assim que o
 * usuário mudar o Kontakt para `WASAPI (Shared Mode)`.
 */
import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  isNativeLoopbackDeviceId,
  nativeLoopbackDeviceNameFromId,
  SYSTEM_DEFAULT_AUDIO_INPUT_ID,
} from './autoSampler';

export interface StereoLevelDb {
  l: number;
  r: number;
}

const FLOOR_DB = -60;
const SILENCE: StereoLevelDb = { l: FLOOR_DB, r: FLOOR_DB };

function rmsToDb(rms: number): number {
  if (rms <= 0 || !Number.isFinite(rms)) return FLOOR_DB;
  const db = 20 * Math.log10(rms);
  return Math.max(FLOOR_DB, Math.min(0, db));
}

function channelRms(buf: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < buf.length; i += 1) sum += buf[i] * buf[i];
  return Math.sqrt(sum / buf.length);
}

export function useInputLevelMeter(
  deviceId: string,
  enabled: boolean,
  gainDb: number
): { levels: StereoLevelDb; error: string | null; retryNow: () => void } {
  const [levels, setLevels] = useState<StereoLevelDb>(SILENCE);
  const [error, setError] = useState<string | null>(null);
  const [retryTrigger, setRetryTrigger] = useState(0);
  const gainNodeRef = useRef<GainNode | null>(null);
  const gainDbRef = useRef<number>(gainDb);

  // Mantém o ganho linear atualizado tanto pro GainNode (getUserMedia)
  // quanto pro cálculo em cima do RMS vindo do loopback nativo, sem reabrir
  // o stream quando o usuário arrasta o slider de Input Gain.
  useEffect(() => {
    gainDbRef.current = gainDb;
    if (gainNodeRef.current) {
      gainNodeRef.current.gain.value = Math.pow(10, gainDb / 20);
    }
  }, [gainDb]);

  // Garante que, ao desmontar o modal do Auto Sampler por completo, qualquer
  // sessão de loopback aberta pelo medidor seja encerrada no Rust.
  useEffect(() => {
    return () => {
      void invoke('loopback_stop').catch(() => {});
    };
  }, []);

  useEffect(() => {
    if (!enabled || !deviceId) {
      setLevels(SILENCE);
      return;
    }

    // Caminho 1: Loopback nativo (WASAPI no Windows) — mede direto o que sai
    // no dispositivo de saída do sistema (onde o Kontakt toca), sem depender
    // de microfone nem de cabo virtual.
    if (isNativeLoopbackDeviceId(deviceId)) {
      let cancelled = false;
      let pollTimer: ReturnType<typeof setInterval> | null = null;
      let retryTimer: ReturnType<typeof setTimeout> | null = null;
      const deviceName = nativeLoopbackDeviceNameFromId(deviceId);

      const startPolling = () => {
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = setInterval(() => {
          if (cancelled) return;
          void invoke<{ rmsL?: number; rms_l?: number; rmsR?: number; rms_r?: number }>('loopback_get_levels')
            .then((lv) => {
              if (cancelled) return;
              const rawL = lv.rmsL ?? lv.rms_l ?? 0;
              const rawR = lv.rmsR ?? lv.rms_r ?? 0;
              const gainLinear = Math.pow(10, gainDbRef.current / 20);
              setLevels({
                l: rmsToDb(rawL * gainLinear),
                r: rmsToDb(rawR * gainLinear),
              });
            })
            .catch(() => {
              /* ignora falha pontual de leitura */
            });
        }, 60);
      };

      const tryOpenLoopback = async () => {
        if (cancelled) return;
        try {
          await invoke('loopback_start', { deviceName });
          if (cancelled) return;
          setError(null);
          startPolling();
        } catch (err) {
          if (cancelled) return;
          const message = err instanceof Error ? err.message : String(err);
          setError(message);
          setLevels(SILENCE);
          // Tenta abrir de novo automaticamente a cada 2s (ex.: enquanto o
          // usuário troca o Kontakt de "WASAPI (Exclusive Mode)" / "ASIO"
          // para "WASAPI (Shared Mode)" por causa do erro 0x8889000A).
          retryTimer = setTimeout(() => {
            void tryOpenLoopback();
          }, 2000);
        }
      };

      void tryOpenLoopback();

      return () => {
        cancelled = true;
        if (pollTimer) clearInterval(pollTimer);
        if (retryTimer) clearTimeout(retryTimer);
        setLevels(SILENCE);
      };
    }

    // Caminho 2: Entrada tradicional via Web Audio / getUserMedia (microfone
    // ou cabo de áudio virtual como VB-Audio Virtual Cable / BlackHole).
    // Se estava em loopback nativo antes, fecha a sessão nativa ao trocar.
    void invoke('loopback_stop').catch(() => {});

    let cancelled = false;
    let stream: MediaStream | null = null;
    let ctx: AudioContext | null = null;
    let raf = 0;
    setError(null);

    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio:
            deviceId === SYSTEM_DEFAULT_AUDIO_INPUT_ID
              ? {
                  echoCancellation: false,
                  noiseSuppression: false,
                  autoGainControl: false,
                }
              : {
                  deviceId: { exact: deviceId },
                  echoCancellation: false,
                  noiseSuppression: false,
                  autoGainControl: false,
                },
          video: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        ctx = new AudioContext();
        const source = ctx.createMediaStreamSource(stream);
        const gainNode = ctx.createGain();
        gainNode.gain.value = Math.pow(10, gainDbRef.current / 20);
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
        splitter.connect(analyserR, inputChannels > 1 ? 1 : 0);

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
  }, [deviceId, enabled, retryTrigger]);

  return {
    levels,
    error,
    retryNow: () => setRetryTrigger((n) => n + 1),
  };
}
