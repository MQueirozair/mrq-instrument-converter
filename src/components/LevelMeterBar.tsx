/** Barra de medidor de nível (dBFS, -60..0) — ver useInputLevelMeter.ts. Mapeamento linear de dB pra % de preenchimento (medidor simples, não um VU/PPM de verdade, mas já dá o feedback visual que faltava num slider de ganho "cego"). */
const FLOOR_DB = -60;

function pct(db: number): number {
  return Math.max(0, Math.min(100, ((db - FLOOR_DB) / -FLOOR_DB) * 100));
}

export default function LevelMeterBar({ label, db }: { label: string; db: number }) {
  const p = pct(db);
  const color = db > -3 ? '#e0524a' : db > -12 ? '#e0b84a' : '#4ab55a';
  return (
    <div className="as-level-meter-row">
      <div className="as-level-meter-label">{label}</div>
      <div className="as-level-meter-track">
        <div className="as-level-meter-fill" style={{ width: `${p}%`, background: color }} />
        <div className="as-level-meter-zero-mark" />
      </div>
      <div className="as-level-meter-db">{db <= FLOOR_DB ? '-∞' : db.toFixed(0)}dB</div>
    </div>
  );
}
