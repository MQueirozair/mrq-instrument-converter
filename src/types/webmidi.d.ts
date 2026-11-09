// Tipos mínimos da Web MIDI API (caso a lib DOM do TS instalada não os inclua).
export {};

declare global {
  interface MIDIMessageEvent extends Event {
    data: Uint8Array;
  }

  interface MIDIPort extends EventTarget {
    id: string;
    name?: string;
    manufacturer?: string;
    state: string;
  }

  interface MIDIInput extends MIDIPort {
    onmidimessage: ((this: MIDIInput, ev: MIDIMessageEvent) => void) | null;
  }

  // Usado pelo Auto Sampler (src/audio/rack/autoSampler.ts) pra mandar
  // Note On/Off de verdade pro Kontakt — `send` aceita tanto um array comum
  // quanto um typed array de bytes MIDI crus; `timestamp` (DOMHighResTimeStamp,
  // em ms desde `performance.timeOrigin`) é opcional e, se omitido, manda
  // imediatamente (mesmo comportamento do spec Web MIDI).
  interface MIDIOutput extends MIDIPort {
    send(data: number[] | Uint8Array, timestamp?: number): void;
  }

  interface MIDIAccess extends EventTarget {
    inputs: Map<string, MIDIInput>;
    outputs: Map<string, MIDIOutput>;
    onstatechange: ((this: MIDIAccess, ev: Event) => void) | null;
  }

  interface Navigator {
    requestMIDIAccess?: (options?: { sysex?: boolean }) => Promise<MIDIAccess>;
  }
}
